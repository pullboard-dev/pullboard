/** @pullboard-test-input apps/cli/src/logic/step/words.js packages/moves/src/io/registry.js packages/state/src/io/engine.js packages/state/src/io/machine.js packages/state/src/logic/engines/train-check-repoint-engine.js */
/** @pullboard-test-loads packages/state/src/io/machine.js packages/state/src/io/engine.js packages/moves/src/io/registry.js */
/** A native train landing repairs only live checks for test files it splits [H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  ENGINE_REGISTRY,
  ENGINE_VERSION,
} from '../../../../packages/state/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  readGateReceipt,
  receiptStore,
} from '../../../../packages/gate/index.js';
import { recordTrainLanding } from '../../../../packages/landing/index.js';
import { copyCommittedPackageFiles } from '../../tests/fixtures/copy.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';

/** Open the fixture's own SQLite board; no shared or live board is touched. */
function onBoard(box, action) {
  // @pullboard-board-file journey: this fixture inspects its own isolated SQLite lifecycle and never opens a shared board.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

test('clause 1: a future client replays move floors while refusal guidance loads [C7,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-check-repoint-engine-'));
  const oldClient = join(directory, 'old-client');
  const futureClient = join(directory, 'future-client');
  mkdirSync(oldClient);
  mkdirSync(futureClient);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  unpackRelease('f8f7b957a85ff2bec478fc6927fede54329acdd6', oldClient);
  unpackRelease('HEAD', futureClient);

  const featureEngine = ENGINE_REGISTRY['train-check-repoint'];
  const futureEngineNumber = Math.max(ENGINE_VERSION, featureEngine) + 1;
  writeFileSync(join(futureClient, 'packages/state/src/logic/engines/train-check-repoint-engine.js'),
    `/** The original landing-assigned feature floor. */\nexport const TRAIN_CHECK_REPOINT_ENGINE = ${featureEngine};\n`);
  writeFileSync(join(futureClient, 'packages/state/src/logic/engines/future-engine.js'),
    `/** A later engine added only to this private replay fixture. */\nexport const FUTURE_ENGINE = ${futureEngineNumber};\n`);

  const oldClientUrl = pathToFileURL(join(oldClient, 'src/'));
    const [oldMachine, oldEngine, futureMachine, futureEngine, futureMoves, futureWords] = await Promise.all([
    import(new URL('machine.js', oldClientUrl)), import(new URL('engine.js', oldClientUrl)),
    import(pathToFileURL(join(futureClient, 'packages/state/src/io/machine.js'))),
    import(pathToFileURL(join(futureClient, 'packages/state/src/io/engine.js'))),
    import(pathToFileURL(join(futureClient, 'packages/moves/src/io/registry.js'))),
    import(pathToFileURL(join(futureClient, 'apps/cli/src/logic/step/words.js'))),
  ]);
  assert.ok(oldMachine.ENGINE_VERSION < featureEngine,
    'the genuine older executable refuses a move above its actual engine');
  assert.equal(futureMachine.ENGINE_VERSION, futureEngineNumber);
  const move = { version: 1, engine: featureEngine, id: 'check-repoint-feature',
    operation: 'recordTrainLanding', args: [{ checkRepointPlan: { version: 1 } }] };
  assert.throws(() => oldEngine.requireSupportedEngine(move), error => error.code === 'ENGINE_VERSION',
    'an older executable refuses a feature move before interpreting it');
  assert.doesNotThrow(() => futureEngine.requireSupportedEngine(move),
    'the later executable accepts the original feature-engine envelope');
  assert.equal(futureMoves.minimumMoveEngine(move.operation, move.args), featureEngine,
    'the later executable keeps the move at its fixed introduction floor');
  assert.equal(futureWords.NEXT_STEPS.PROOF_RUN_UNBOUND, futureMoves.MOVE_REGISTRY.recordProofRun.nextSteps.PROOF_RUN_UNBOUND,
    'the future client reads discovered move guidance after registry discovery without an import cycle');
  assert.equal(minimumMoveEngine(move.operation, move.args), featureEngine,
    'the current runtime uses the same recorded feature floor');
});

test('clause 2: a split train landing repoints open and claimed checks and reports submitted checks unchanged [C7,H16]',
  { timeout: 120_000 }, async t => { // budget: private project setup, one native gate and owned cleanup.
    const helpers = createE2eHelpers();
    const box = helpers.project('node apps/cli/src/io/run/tests.js web/legacy-a.test.js web/legacy-b.test.js', undefined, { withWorktree: false });
    t.after(async () => helpers.cleanup());
    delete box.env.NODE_TEST_CONTEXT;
    const fixtureHooks = join(box.dir, 'fixture-hooks');
    mkdirSync(fixtureHooks);
    box.git(box.repo, 'config', 'core.hooksPath', fixtureHooks);
    copyCommittedPackageFiles(box, join(import.meta.dirname, '../../../..'));
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'web/legacy.test.js'),
      "import { test } from 'node:test'; test('legacy fixture [H16]',()=>{});\n");
    const configPath = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config,
      landing: { perItem: false, manualOverride: true, publish: 'separate', requireReceipts: true }, pushReceiptCheck: { smoke: 'node -e ""' } }));
    box.git(box.repo, 'add', '--', 'package.json', 'pullboard.json', 'web/legacy.test.js');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare split landing fixture');
    const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const baseTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
    const check = 'node apps/cli/src/io/run/tests.js web/legacy.test.js';
    const freeze = criterion => {
      const text = JSON.stringify({ criterion, rows: [], policy: { version: 1, commit: base,
        verify: { policy: 'any', family: 'off' } } });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    };
    const makeItem = (board, title, itemCheck = check) => store.addItem(board, { by: 'coordinator', lane: 'web', title,
      criterion: 'Keep the selected check valid after a test split.', check: itemCheck, route: 'mid',
      brief: `Files: web/legacy.test.js\nTest: ${title} keeps the selected check valid after a split.` });
    const prepared = onBoard(box, board => {
      const openBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'open-builder') });
      const claimedBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'claimed-builder') });
      const submittedBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'submitted-builder') });
      const trainBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'train-builder') });
      const openId = makeItem(board, 'Open check');
      const claimedId = makeItem(board, 'Claimed check');
      const submittedId = makeItem(board, 'Submitted check');
      const malformedId = makeItem(board, 'Malformed check', "node apps/cli/src/io/run/tests.js 'web/legacy.test.js");
      const trainId = makeItem(board, 'Landing carrier');
      store.claim(board, openId, { agentId: openBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Open check') });
      store.release(board, openId, openBuilder, 'Return the fixture claim to open for split repair.', undefined, 'OTHER');
      store.claim(board, claimedId, { agentId: claimedBuilder, lane: 'web', leaseMs: 86_400_000, head: base,
        freeze: () => freeze('Claimed check') });
      store.claim(board, submittedId, { agentId: submittedBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Submitted check') });
      submitFixture(board, submittedId, { agentId: submittedBuilder, commit: base, tree: baseTree });
      store.claim(board, malformedId, { agentId: openBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Malformed check') });
      store.release(board, malformedId, openBuilder, '', undefined, 'BLOCKED');
      store.claim(board, trainId, { agentId: trainBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Landing carrier') });
      return { trainBuilder, openId, claimedId, submittedId, malformedId, trainId };
    });

    writeFileSync(join(box.repo, 'web/carried-source.txt'), 'source accepted by the fixture board\n');
    box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'feat(web): carry split fixture [G1]');
    const itemCommit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const itemTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
    onBoard(box, board => {
      submitFixture(board, prepared.trainId, { agentId: prepared.trainBuilder, commit: itemCommit, tree: itemTree });
      store.verify(board, prepared.trainId, { agentId: 'coordinator', decision: 'ACCEPT',
        note: 'Synthetic lifecycle setup; the landing gate below is real.', head: itemCommit,
        digest: store.getItem(board, prepared.trainId).item_frozen_digest, policy: 'any' });
    });

    writeFileSync(join(box.repo, 'web/legacy-a.test.js'),
      "import { test } from 'node:test'; test('first split fixture [H16]',()=>{});\n");
    writeFileSync(join(box.repo, 'web/legacy-b.test.js'),
      "import { test } from 'node:test'; test('second split fixture [H16]',()=>{});\n");
    mkdirSync(join(box.repo, 'web/legacy-extra'), { recursive: true });
    writeFileSync(join(box.repo, 'web/legacy-extra/legacy-c.test.js'),
      "import { test } from 'node:test'; test('nested lookalike fixture [H16]',()=>{});\n");
    box.git(box.repo, 'rm', '-q', '--', 'web/legacy.test.js');
    box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'test: split legacy test entry');
    const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const gate = (await box.runLocal(box.repo, 'gate', '--landing', '--receipt', '--json'));
    assert.equal(gate.code, 0, `${gate.out}${gate.err}`);
    const receiptId = JSON.parse(gate.out).receiptId;
    assert.ok(receiptId);
    const receipt = readGateReceipt(receiptStore(box.repo), receiptId);
    assert.ok(receipt, 'the native gate retained its source-bound receipt');

    const landed = onBoard(box, board => {
      const request = board.enginePorts.prepareTrainLanding(box.repo, board, [prepared.trainId], tip, receiptId);
      assert.deepEqual(request.checkRepointPlan.entries.map(entry => entry.id).sort((a, b) => a - b),
        [prepared.openId, prepared.claimedId].sort((a, b) => a - b));
      const blocked = request.checkRepointPlan.blocked.toSorted((a, b) => a.id - b.id);
      assert.deepEqual(blocked.map(entry => entry.id), [prepared.submittedId, prepared.malformedId]);
      assert.match(blocked[1].reason, /unclosed quote/u);
      return recordTrainLanding(board, request);
    });
    assert.deepEqual(landed.checkRepointReport.applied.toSorted((a, b) => a - b),
      [prepared.openId, prepared.claimedId].sort((a, b) => a - b));
    assert.deepEqual(landed.checkRepointReport.blocked.map(entry => entry.id).sort((a, b) => a - b),
      [prepared.submittedId, prepared.malformedId].sort((a, b) => a - b));
    const expected = "node apps/cli/src/io/run/tests.js 'web/legacy-a.test.js' 'web/legacy-b.test.js'";
    onBoard(box, board => {
      assert.equal(store.getItem(board, prepared.openId).item_check, expected);
      assert.equal(store.getItem(board, prepared.openId).item_status, 'open');
      assert.equal(store.getItem(board, prepared.claimedId).item_check, expected);
      assert.equal(store.getItem(board, prepared.claimedId).item_status, 'claimed');
      assert.equal(store.getItem(board, prepared.submittedId).item_check, check);
      assert.equal(store.getItem(board, prepared.malformedId).item_check, "node apps/cli/src/io/run/tests.js 'web/legacy.test.js");
      for (const id of [prepared.openId, prepared.claimedId]) {
        const edit = store.events(board, { itemId: id }).find(event => event.event_kind === 'edit');
        assert.deepEqual(JSON.parse(edit.event_detail).barCorrection.fields, ['check']);
      }
      const repeated = board.enginePorts.prepareNativeTrainLanding(box.repo, board, landed.id, receiptId);
      assert.deepEqual(recordTrainLanding(board, repeated), landed,
        'the recorded correction report does not break idempotent landed-batch recovery');
    });
  });
