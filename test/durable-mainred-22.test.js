/** Durable gate 22: main-red status is a receipt lookup keyed by main tree, test file and command [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { jobView } from '../packages/jobs/index.js';
import { mainRedLookup, classifyGateRed, MAIN_TEST_JOB } from '../packages/drive/index.js';
import { mainRedKey, mainRedStatus } from '../packages/receipt/index.js';

const files = privateFixtureFiles('pullboard-durable-mainred-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

const at = { tree: 'tree-main-1', file: 'test/a.test.js', command: 'npm test --' };
const red = { id: 'mr-1', ...at, verdict: 'red', failing: ['case one', 'case two'] };

test('clause 1: main-red status is read from the receipt keyed by (main tree, file, command); a missing receipt enqueues a main-test job [C7]', () => {
  assert.equal(mainRedKey(at.tree, at.file, at.command), mainRedKey(at.tree, at.file, at.command));
  assert.notEqual(mainRedKey(at.tree, at.file, at.command), mainRedKey('tree-main-2', at.file, at.command), 'a new main tree is a new key');
  assert.notEqual(mainRedKey(at.tree, at.file, at.command), mainRedKey(at.tree, at.file, 'make test'), 'another command is a new key');
  assert.throws(() => mainRedKey(at.tree, '', at.command), { code: 'MAIN_RED_KEY' });

  assert.deepEqual(mainRedStatus([red], at), { key: mainRedKey(at.tree, at.file, at.command), status: 'red', receipt: 'mr-1', failing: ['case one', 'case two'] });
  assert.equal(mainRedStatus([red], { ...at, tree: 'tree-main-2' }).status, 'missing', 'a receipt for another tree never answers');

  withBoard('lookup', (db) => {
    const found = mainRedLookup(db, [red], { ...at, now: 1000 });
    assert.equal(found.status, 'red');
    assert.equal(found.job, null, 'a present receipt enqueues nothing');

    const missing = { ...at, tree: 'tree-main-2', now: 2000 };
    const first = mainRedLookup(db, [red], missing);
    assert.equal(first.status, 'missing');
    assert.equal(first.job, `${MAIN_TEST_JOB}:${mainRedKey('tree-main-2', at.file, at.command)}`);
    const job = jobView(db, first.job);
    assert.equal(job.kind, MAIN_TEST_JOB);
    assert.equal(job.step, 'queued', 'the job waits for a driver: nothing ran');
    assert.equal(job.leaseOwner, null, 'no process took it');
    assert.deepEqual(job.steps.map((step) => step.payload), [{ tree: 'tree-main-2', file: at.file, command: at.command }]);

    const again = mainRedLookup(db, [red], { ...missing, now: 3000 });
    assert.equal(again.job, first.job, 'a second ask for the same key reuses the one job');
    assert.equal(jobView(db, first.job).steps.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE job_kind = ?').get(MAIN_TEST_JOB).n, 1);
  });
});

test('clause 2: a gate red only on cases red in main\'s receipt is main\'s own red, with the receipt id in the result [C7]', () => {
  withBoard('classify', (db) => {
    const own = classifyGateRed(db, [red], { ...at, reds: ['case two'] });
    assert.deepEqual(own, { file: at.file, owner: 'main', receipt: 'mr-1', own: [], code: 'MAIN_OWN_RED', job: null });

    const mixed = classifyGateRed(db, [red], { ...at, reds: ['case two', 'case three'] });
    assert.equal(mixed.owner, 'candidate', 'a red main does not name is the candidate\'s own');
    assert.deepEqual(mixed.own, ['case three']);
    assert.equal(mixed.receipt, 'mr-1');

    const green = classifyGateRed(db, [{ ...red, id: 'mr-g', verdict: 'green', failing: [] }], { ...at, reds: ['case one'] });
    assert.equal(green.owner, 'candidate', 'main green on the file means the red is the candidate\'s');
    assert.equal(green.receipt, 'mr-g');

    const unknown = classifyGateRed(db, [], { ...at, reds: ['case one'] });
    assert.equal(unknown.owner, 'unknown');
    assert.equal(unknown.code, 'MAIN_RECEIPT_MISSING');
    assert.equal(jobView(db, unknown.job).step, 'queued', 'with no receipt the main-test job is queued, never guessed');
  });
});
