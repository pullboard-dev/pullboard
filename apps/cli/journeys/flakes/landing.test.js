/** @pullboard-test-input source-tree */
/** Native flake landing: a red landing keeps its original verdict and a retained diagnostic is consumed once [C7,H16]. */
import {
  flakyProject,
  targetRuns,
  assertReceipts,
  privateBuilder,
  commitCandidate,
  checkedItem,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { landingPorts } from '../../tests/fixtures/landing/ports.js';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { openBoard } from '../../../lib/index.js';
import { land } from '../../../../packages/landing/index.js';
import { inProcessLandingBatch } from '../../../../packages/landing/index.js';
import { checkAtCommit } from '../../../runner/index.js';

/** Prepare one genuinely submitted and accepted candidate with a private local bare destination. */
function readyLanding(t, rerun) {
  const box = flakyProject(t, { alwaysPass: 'controlled', rerun });
  const remote = join(box.scratch, 'private-origin.git');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', '-u', 'origin', 'main');
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: prepare controlled landing candidate');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  const head = box.cli('show', String(id)).document.item_commit;
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const accepted = reviewer.cli('verify', String(id), 'accept', '--note', 'Private fixture: its exact controlled check passed before the external failure was armed.');
  assert.equal(accepted.code, 0, JSON.stringify(accepted.document));
  // Change the checked input on main so landing measures the merged tree instead of reusing the submit proof.
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.affectedTests = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap';
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  appendFileSync(join(box.root, 'test/alternating.test.mjs'), '\n// Advance the checked input on main.\n');
  box.git('add', 'pullboard.json', 'test/alternating.test.mjs');
  box.git('commit', '-q', '-m', 'test: advance controlled landing input');
  box.git('push', '-q', 'origin', 'main');
  const base = box.git('rev-parse', 'HEAD').trim();
  writeFileSync(box.counter, '');
  writeFileSync(box.counter + '.mode', 'paired');
  return { ...box, remote, base, id };
}

test('enabled landing retains its original red without a second diagnostic or first legacy defect [C7,H16]', t => {
  const box = readyLanding(t, true);
  const result = box.cli('land');
  assert.equal(result.code, 1, JSON.stringify(result.document)); // a batch whose every candidate is a culprit exits 1 (#4265)
  assert.equal(result.document.batch.state, 'blocked');
  assert.deepEqual(result.document.landed, []);
  assert.deepEqual(result.document.flakes, [], 'typed observations do not file a first-sighting legacy landing_flake');
  assert.equal(result.document.batch.gateResults[0].isGreen, false, 'the diagnostic pass never replaces the original red');
  // The landing also compares its red file with base main (#3073), which executes the target once more in a main checkout.
  assert.equal(targetRuns(box), 4, 'one original, one exact-target pair, one independently pinned main control, one base-main comparison; no legacy whole-file remeasurement');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].count, 1);
  // Changed with #3131: a proven ledger flake files its repair on the first sighting.
  assert.ok(Number.isSafeInteger(report.flakes[0].item), 'a proven flake files one repair item on its first sighting');
  assert.equal(report.flakes[0].observations[0].kind, 'land');
  assertReceipts(box, report.flakes[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base, 'the private destination received no landing');
  const refused = box.cli('land', '--adopt');
  assert.equal(refused.document.error?.code, 'LAND_ADOPT', 'a terminal blocked batch is not an interrupted landing');
  assert.equal(targetRuns(box), 4, 'a refused adoption adds no measurement');
  assert.equal(box.cli('flakes').document.flakes[0].count, 1);
});

/** Interrupt the dependency at its final blocked write after real diagnostics were durably recorded, then use normal CLI adoption. */
test('an interrupted landing consumes its saved diagnostic without inventing another measurement [C7,H16]', async t => {
  const box = readyLanding(t, true);
  // The direct public API call cannot inherit cliAt's private identity environment; set only this synthetic repo's identity.
  box.git('config', '--local', 'user.name', 'Fixture Agent');
  box.git('config', '--local', 'user.email', 'fixture@example.com');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    // The product's own config loader reads the fixture repo's settings, as automatic landing does.
    const config = loadConfig(box.root);
    // A direct API call must not hand Node's outer test-worker protocol to its own configured Node test command.
    const context = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let completed;
    try {
      await assert.rejects(land({ landingPorts, root: box.root, board, config, owner: 'private-interrupted-owner', say: () => {}, runBatch: inProcessLandingBatch({ checkAtCommit, candidateWorkerFile: resolve(import.meta.dirname, '../../../lib/src/io/landing/candidate.js') }),
        write: async (operation, args) => {
          if (operation === 'recordLandingBatch' && args[0].batch.state === 'blocked') throw new Error('controlled interruption after retained diagnostic');
          return board.enginePorts.store[operation](board, ...args);
        } }).then(result => { completed = result; return result; }), /controlled interruption after retained diagnostic/u);
    } catch (error) {
      const saved = store.landingBatches(board).at(-1);
      t.diagnostic(JSON.stringify({ unexpectedCompletion: completed?.batch?.state ?? null, targetRuns: targetRuns(box), savedState: saved?.state }));
      for (const gate of saved?.gateResults ?? []) if (gate.logPath) t.diagnostic(box.readData(gate.logPath, 'utf8'));
      throw error;
    } finally {
      if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = context;
    }
    const saved = store.landingBatches(board).at(-1);
    assert.equal(saved.state, 'gating');
    assert.equal(saved.gateResults[0].isGreen, false);
    assert.equal(saved.gateResults[0].flakeDiagnostics.observations[0].recorded, true);
  } finally { store.closeBoard(board); }
  // Changed today with the landing rerun change: an interrupted landing has run the target once by this point.
  assert.equal(targetRuns(box), 4, 'the real interrupted landing completed its original, pair, control and base-main comparison runs');
  const adopted = box.cli('land', '--adopt');
  assert.equal(adopted.code, 1, JSON.stringify(adopted.document)); // the adopted batch ends blocked with every candidate a culprit
  assert.equal(adopted.document.batch.state, 'blocked');
  assert.equal(targetRuns(box), 4, 'normal adoption consumes the retained diagnostics, never a confidence rerun');
  const adoptedReport = box.cli('flakes').document;
  assert.equal(adoptedReport.flakes.length, 1, 'the retained pair is red then green, so the ledger holds one flake sighting, as the uninterrupted landing does');
  assert.equal(adoptedReport.flakes[0].observations.length, 1, 'adoption does not invent a second sighting');
  assert.equal(adoptedReport.flakes[0].count, 1);
  assert.deepEqual(adoptedReport.stable, []);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});

test('landing with reruns off keeps its original red and runs nothing further [C7,H16]', t => {
  const box = readyLanding(t, false);
  const result = box.cli('land');
  assert.equal(result.code, 1, JSON.stringify(result.document)); // a batch whose every candidate is a culprit exits 1 (#4265)
  // Changed today with the landing rerun change: a red landing with reruns off stays blocked, files no legacy defect and runs the target once.
  assert.equal(result.document.batch.state, 'blocked');
  assert.deepEqual(result.document.landed, []);
  assert.equal(result.document.flakes.length, 0, 'no first-sighting legacy defect is filed');
  assert.equal(targetRuns(box), 2, 'the original run plus the base-main comparison (#3073) execute, with no new paired rerun');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0, 'a whole-file diagnosis is not relabeled as exact-target confirmation');
  assert.equal(report.unclassified.length, 1, 'the new ledger still retains the original red');
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});
