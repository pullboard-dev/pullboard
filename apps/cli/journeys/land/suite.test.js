/** A batch that breaks an unaffected test files one Main red naming it; a green batch files nothing [C7,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { finishTrunk } from '../../../../packages/landing/index.js';
import { openBoard } from '../../../lib/index.js';
import { postLandSuite } from '../../../../packages/landing/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { unownedMainReds } from '../../../../packages/store/index.js';
import { copyCommittedPackageFiles } from '../../tests/fixtures/copy.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

/** A landing state whose writes and lines are captured, with a suite that answers from a script. */
function harness(t) {
  const folder = mkdtempSync(join(tmpdir(), 'post-land-suite-'));
  folders.push(folder);
  const storePath = join(folder, 'result.json');
  const added = [];
  const said = [];
  const open = [];
  const state = { board: {}, config: { lanes: { core: { owns: ['test/', 'src/', 'apps/cli/journeys/'] }, coordinator: { owns: ['docs/'] } }, affectedTests: 'node apps/cli/src/io/run/tests.js' },
    write: async (operation, [item]) => { assert.equal(operation, 'addItem'); added.push(item); const id = 900 + added.length;
      open.push({ item_id: id, item_status: 'open', item_title: item.title, item_criterion: item.criterion, item_brief: item.brief, item_check: item.check, item_lane: item.lane }); return id; },
    say: text => said.push(text), batch: null };
  /** Land one batch whose full suite reports exactly these red cases. */
  const land = async (id, items, failures, extra = {}) => {
    state.batch = { id, tip: `${id}`.padEnd(40, 'a'), root: folder, items: items.map(item => ({ id: item })) };
    return postLandSuite(state, { enabled: () => true, storePath: () => storePath, readItems: () => open, laneOf, unownedMainReds,
      runSuite: async () => ({ green: failures?.length === 0, failures }), ...extra });
  };
  return { state, land, added, said, storePath };
}

test('a batch that breaks an unaffected test files exactly one Main red naming the batch and its items [C7,H16]', async t => {
  const box = harness(t);
  await box.land('b1', [10], []);
  const result = await box.land('b2', [11, 12], [{ file: 'apps/cli/journeys/health/main.test.js', name: 'footer renders' }]);
  assert.equal(box.added.length, 1);
  const [item] = box.added;
  assert.match(item.title, /health\/main\.test\.js/u);
  assert.match(item.criterion, /b2/u);
  assert.match(item.criterion, /#11, #12/u);
  assert.match(item.criterion, /footer renders/u);
  assert.match(item.check, /health\/main\.test\.js/u);
  assert.equal(item.lane, 'core');
  assert.equal(result.filed.length, 1);
});

test('a green batch files nothing and the baseline carries forward [C7,H16]', async t => {
  const box = harness(t);
  await box.land('b1', [10], []);
  await box.land('b2', [11], []);
  assert.deepEqual(box.added, []);
  assert.ok(box.said.some(line => /b2/u.test(line) && /green/u.test(line)), 'the outcome is a greppable line naming the batch');
});

test('the first run is a baseline: reds already present are not blamed on its batch [C7,H16]', async t => {
  const box = harness(t);
  const result = await box.land('b1', [10], [{ file: 'test/old.test.js', name: 'was red before' }]);
  assert.deepEqual(box.added, []);
  assert.equal(result.baseline, true);
});

test('a red that persists, or already has an open owner, files nothing more [C7,H16]', async t => {
  const box = harness(t);
  await box.land('b1', [10], []);
  const red = [{ file: 'apps/cli/journeys/health/main.test.js', name: 'footer renders' }];
  await box.land('b2', [11], red);
  await box.land('b3', [12], red);
  assert.equal(box.added.length, 1, 'the same red on the next batch is known, not new');
  await box.land('b4', [13], []);
  await box.land('b5', [14], red);
  assert.equal(box.added.length, 1, 'an open owner already names the file, so a second one is not filed');
});

test('an unaccounted red keeps the previous result and files nothing, loudly [C7,H16]', async t => {
  const box = harness(t);
  await box.land('b1', [10], []);
  const result = await box.land('b2', [11], null, { runSuite: async () => ({ green: false, failures: null }) });
  assert.equal(result.accounted, false);
  assert.deepEqual(box.added, []);
  assert.ok(box.said.some(line => /b2/u.test(line) && /accounted for/u.test(line)));
  await box.land('b3', [12], [{ file: 'test/x.test.js', name: 'new' }]);
  assert.equal(box.added.length, 1, 'b1 stayed the baseline');
});

test('a filing failure never refuses the landing and leaves the baseline for a retry [C7,H16]', async t => {
  const box = harness(t);
  await box.land('b1', [10], []);
  box.state.write = async () => { throw new Error('board unavailable'); };
  const result = await box.land('b2', [11], [{ file: 'test/x.test.js', name: 'new' }]);
  assert.match(result.error, /board unavailable/u);
  assert.ok(box.said.some(line => /b2/u.test(line) && /board unavailable/u.test(line)));
});

test('it is off unless the machine setting turns it on [C7,H16]', async t => {
  const box = harness(t);
  box.state.batch = { id: 'b1', tip: 'a'.repeat(40), root: tmpdir(), items: [{ id: 1 }] };
  const result = await postLandSuite(box.state, { enabled: () => false, runSuite: async () => { throw new Error('must not run'); } });
  assert.equal((await postLandSuite(box.state, undefined)).ran, false, 'no ports means off');
  assert.equal(result.ran, false);
  assert.deepEqual(box.said, []);
});

/** Seed a verified item and a real local-trunk batch, then finish it through the production landing step. */
test('a real landed batch files a newly red case and a green batch files nothing [C7,H16]', async t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('node apps/cli/src/io/run/tests.js', undefined, { withWorktree: false });
  t.after(() => helpers.cleanup());
  delete box.env.NODE_TEST_CONTEXT;
  copyCommittedPackageFiles(box, join(import.meta.dirname, '../../../..'));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/train.test.js'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('unaffected landing test [C7]', () => assert.equal(1, 1));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare post-land integration fixture');
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: real private SQLite item acceptance and train-batch landing drive the post-land hook
  const board = openBoard(boardFile, undefined, { isMain: true });
  const observed = [];
  const said = [];
  const resultFile = join(box.repo, '.git', 'pullboard', 'post-land-suite.json');
  let suiteRun = 0;

  /** Commit one fixture result from a candidate worktree, record its native batch, then use finishTrunk. */
  async function landFixtureBatch(number, red) {
    const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
    const candidate = join(box.dir, `post-land-candidate-${number}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', candidate, base);
    try {
      const actor = store.register(board, { lane: 'web', path: candidate });
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Post-land fixture ${number}`, criterion: 'The accepted batch has a source commit.' });
      const frozen = JSON.stringify({ criterion: 'The accepted batch has a source commit.' });
      const digest = createHash('sha256').update(frozen).digest('hex');
      store.claim(board, id, { agentId: actor, lane: 'web', leaseMs: 3_600_000, head: base,
        freeze: () => ({ text: frozen, digest }) });
      if (number === 2) writeFileSync(join(candidate, 'web/train.test.js'),
        "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('unaffected landing test [C7]', () => assert.equal(1, 2));\n");
      if (number === 3) writeFileSync(join(candidate, 'web/train.test.js'),
        "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('unaffected landing test [C7]', () => assert.equal(1, 1));\n");
      writeFileSync(join(candidate, `web/batch-${number}.txt`), `batch ${number}\n`);
      box.git(candidate, 'add', '-A');
      box.git(candidate, 'commit', '-q', '-m', `feat(web): fixture batch ${number} [G1]`);
      const tip = box.git(candidate, 'rev-parse', 'HEAD').trim();
      const tree = box.git(candidate, 'rev-parse', 'HEAD^{tree}').trim();
      submitFixture(board, id, { agentId: actor, commit: tip, tree, files: ['web/train.test.js'], policyCommit: base });
      store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'synthetic lifecycle setup; no gate claim',
        head: tip, digest, policy: 'any' });
      const batchId = randomUUID();
      const batch = store.recordLandingBatch(board, { agentId: 'coordinator', batch: { version: 1, id: batchId, state: 'trunk',
        base, tip, root: candidate, branch: 'refs/heads/main', owner: randomUUID(),
        logPath: join(box.dir, `post-land-${number}.log`), items: [{ id, commit: tip, merge: tip }] } });
      const state = { root: box.repo, board, config: { affectedTests: 'node apps/cli/src/io/run/tests.js',
        lanes: { web: { owns: ['web/'], specs: ['G1'] }, coordinator: { owns: ['docs/'], specs: [] } }, landing: { perItem: false, manualOverride: true, requireReceipts: false } },
      batch, say: text => said.push(text), checkLease: async () => {},
      write: async (operation, parameters) => {
        if (operation === 'finishLandingBatch') return store.finishLandingBatch(board, parameters[0]);
        if (operation === 'addItem') return store.addItem(board, parameters[0]);
        throw new Error(`unexpected fixture board operation ${operation}`);
      },
      landingPorts: {
        validateQuarantineLandingProof: (db, landed) => db.nativePorts.quarantine.validateQuarantineLandingProof(db, landed),
        postLandSuite: {
          enabled: () => true,
          storePath: () => resultFile,
          laneOf,
          unownedMainReds,
          readItems: db => store.listItems(db, { all: true }),
          runSuite: async root => {
            suiteRun++;
            const head = box.git(box.repo, 'rev-parse', 'HEAD').trim();
            observed.push({ root, head, batch: state.batch.id });
            assert.equal(head, state.batch.tip, 'the suite observes the batch after the actual main fast-forward');
            if (suiteRun === 2 && red) return { green: false, failures: [{ file: 'web/train.test.js', name: 'unaffected landing test [C7]' }] };
            return { green: true, failures: [] };
          },
        },
      },
      };
      await finishTrunk(state);
      assert.equal(store.landingBatches(board).find(row => row.id === batchId).state, 'landed');
      return { id, batchId };
    } finally {
      box.git(box.repo, 'worktree', 'remove', '--force', candidate);
    }
  }

  try {
    await landFixtureBatch(1, false);
    const red = await landFixtureBatch(2, true);
    const afterRed = store.listItems(board, { all: true }).filter(item => item.item_title === 'Main red: web/train.test.js');
    assert.equal(afterRed.length, 1);
    assert.match(afterRed[0].item_criterion, new RegExp(`batch ${red.batchId}`));
    assert.match(afterRed[0].item_criterion, /unaffected landing test \[C7\]/u);
    assert.match(afterRed[0].item_check, /web\/train\.test\.js/u);
    await landFixtureBatch(3, false);
    assert.equal(store.listItems(board, { all: true }).filter(item => item.item_title === 'Main red: web/train.test.js').length, 1,
      'the green landed batch files no additional Main red');
    assert.equal(observed.length, 3, 'each actual finishTrunk landing invokes the post-land suite port once');
    assert.ok(said.some(line => /post-land suite.*green/u.test(line)));
  } finally {
    store.closeBoard(board);
  }
});
