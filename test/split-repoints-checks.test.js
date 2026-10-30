/** @pullboard-test-input source-tree */
/** A native train landing repairs only live checks for test files it splits [H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { readGateReceipt, receiptStore } from '../src/gate-run-receipt.js';
import { prepareTrainLanding, prepareNativeTrainLanding } from '../src/train-landing.js';
import { recordTrainLanding } from '../src/record-train-landing.js';
import { copyCommittedPackageFiles } from './package-copy-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Open the fixture's own SQLite board; no shared or live board is touched. */
function onBoard(box, action) {
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

test('a split train landing repoints open and claimed checks and reports submitted checks unchanged',
  { timeout: 120_000 }, async t => { // budget: private project setup, one native gate and owned cleanup.
    const helpers = createE2eHelpers();
    const box = helpers.project('node bin/run-tests.js', undefined, { withWorktree: false });
    t.after(async () => helpers.cleanup());
    delete box.env.NODE_TEST_CONTEXT;
    copyCommittedPackageFiles(box, import.meta.dirname + '/..');
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'web/legacy.test.js'),
      "import { test } from 'node:test'; test('legacy fixture [H16]',()=>{});\n");
    const configPath = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config,
      landing: { publish: 'separate', requireReceipts: true }, pushReceiptCheck: { smoke: 'node -e ""' } }));
    box.git(box.repo, 'add', '--', 'package.json', 'pullboard.json', 'web/legacy.test.js');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare split landing fixture');
    const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const check = 'node bin/run-tests.js web/legacy.test.js';
    const freeze = criterion => {
      const text = JSON.stringify({ criterion, rows: [], policy: { version: 1, commit: base,
        verify: { policy: 'any', family: 'off' } } });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    };
    const makeItem = (board, title) => store.addItem(board, { by: 'coordinator', lane: 'web', title,
      criterion: 'Keep the selected check valid after a test split.', check, route: 'mid',
      brief: 'The selected check names the legacy test entry.' });
    const prepared = onBoard(box, board => {
      const openBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'open-builder') });
      const claimedBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'claimed-builder') });
      const submittedBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'submitted-builder') });
      const trainBuilder = store.register(board, { lane: 'web', path: join(box.dir, 'train-builder') });
      const openId = makeItem(board, 'Open check');
      const claimedId = makeItem(board, 'Claimed check');
      const submittedId = makeItem(board, 'Submitted check');
      const trainId = makeItem(board, 'Landing carrier');
      store.claim(board, openId, { agentId: openBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Open check') });
      store.release(board, openId, openBuilder);
      store.claim(board, claimedId, { agentId: claimedBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Claimed check') });
      store.claim(board, submittedId, { agentId: submittedBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Submitted check') });
      submitFixture(board, submittedId, { agentId: submittedBuilder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
      store.claim(board, trainId, { agentId: trainBuilder, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => freeze('Landing carrier') });
      return { trainBuilder, openId, claimedId, submittedId, trainId };
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
    box.git(box.repo, 'rm', '-q', '--', 'web/legacy.test.js');
    box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'test: split legacy test entry');
    const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const gate = box.run(box.repo, 'gate', '--landing', '--receipt', '--json');
    assert.equal(gate.code, 0, `${gate.out}${gate.err}`);
    const receiptId = JSON.parse(gate.out).receiptId;
    assert.ok(receiptId);
    const receipt = readGateReceipt(receiptStore(box.repo), receiptId);
    assert.ok(receipt, 'the native gate retained its source-bound receipt');

    const landed = onBoard(box, board => {
      const request = prepareTrainLanding(box.repo, board, [prepared.trainId], tip, receiptId);
      assert.deepEqual(request.checkRepointPlan.entries.map(entry => entry.id), [prepared.openId, prepared.claimedId]);
      assert.deepEqual(request.checkRepointPlan.blocked.map(entry => entry.id), [prepared.submittedId]);
      return recordTrainLanding(board, request);
    });
    assert.deepEqual(landed.checkRepointReport.applied, [prepared.openId, prepared.claimedId]);
    assert.deepEqual(landed.checkRepointReport.blocked.map(entry => entry.id), [prepared.submittedId]);
    const expected = 'node bin/run-tests.js web/legacy-a.test.js web/legacy-b.test.js';
    onBoard(box, board => {
      assert.equal(store.getItem(board, prepared.openId).item_check, expected);
      assert.equal(store.getItem(board, prepared.openId).item_status, 'open');
      assert.equal(store.getItem(board, prepared.claimedId).item_check, expected);
      assert.equal(store.getItem(board, prepared.claimedId).item_status, 'claimed');
      assert.equal(store.getItem(board, prepared.submittedId).item_check, check);
      for (const id of [prepared.openId, prepared.claimedId]) {
        const edit = store.events(board, { itemId: id }).find(event => event.event_kind === 'edit');
        assert.deepEqual(JSON.parse(edit.event_detail).barCorrection.fields, ['check']);
      }
      const repeated = prepareNativeTrainLanding(box.repo, board, landed.id, receiptId);
      assert.deepEqual(recordTrainLanding(board, repeated), landed,
        'the recorded correction report does not break idempotent landed-batch recovery');
    });
  });
