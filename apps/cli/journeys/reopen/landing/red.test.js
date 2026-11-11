/** @pullboard-test-input apps/cli/journeys/verify/machine.test.js packages/landing/src/io/step/batch.js packages/landing/src/io/step/trunk.js */
/** Only an item's own red reopens it: batch-wide, foreign-file and infrastructure landing failures reopen nothing [C7,#2967]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { requireFixtureReviewFamilies } from '../../../tests/fixtures/review/family.js';
import { openBoard } from '../../../../lib/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  returnCulprit,
  returnRefusedItem,
} from '../../../../../packages/landing/index.js';
import { itemRefusal } from '../../../../../packages/landing/index.js';
import {
  oneItemBatch,
  singleItemLanding,
} from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const OWN = 'web/own.test.js';
const NAMED = 'web/named.test.js';
const FOREIGN = { file: 'apps/cli/journeys/verify/machine.test.js', name: 'AbortError: This operation was aborted' };

/** Freeze the fixture item's requirement without claiming a test gate ran in this board-state fixture. */
function freeze(item = {}) {
  return { text: JSON.stringify({ criterion: item.item_criterion ?? '', rows: [], policy: { version: 1, verify: { policy: 'any', family: 'off' } } }), digest: 'own-red-fixture' };
}

/**
 * A real project whose item commit changes one test file, on its real SQLite board with the item accepted at that
 * commit and a check naming a second file; the landing's writes reopen on that board, so a return shows as status.
 */
function landing() {
  const box = e2e.project(undefined, e2e.sandbox({ declareFamilies: true }));
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.equal(e2e.commitFile(box, box.web, OWN, 'own\n', 'test(web): own red fixture [G1]').status, 0);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  requireFixtureReviewFamilies(board);
  const reviewer = store.register(board, { lane: 'api', path: join(box.dir, 'own-red-reviewer'), family: 'Fixture Own Red Reviewer Vendor' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Own red fixture', criterion: 'own red fixture', check: `node --test ${NAMED}` });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3600000, head: base, freeze });
  submitFixture(board, id, { agentId: 'web-1', commit, tree, note: 'Own red fixture submission.',
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'private landing fixture, not gate evidence' } });
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Synthetic private acceptance, not an execution claim.',
    head: commit, digest: freeze().digest, policy: 'any', familyPolicy: 'off', check: 'green',
    review: { commit, head: commit, trunk: base, paths: [OWN] } });
  const writes = [];
  const entry = { id, commit };
  const state = { board, culprits: [], say() {}, landingPorts: {},
    batch: null, write: async (operation, args) => { writes.push(operation); return store[operation](board, ...args); } };
  state.batch = store.recordLandingBatch(board, { agentId: 'coordinator', batch: { version: 1, id: 'own-red-batch', state: 'gating', base, tip: commit,
    root: box.web, branch: 'refs/heads/main', owner: 'own-red-fixture', logPath: join(box.dir, 'own-red.log'), items: [entry], candidates: [entry], conflicts: [] }, revision: 0 });
  writes.length = 0;
  return { state, entry, writes, status: () => store.getItem(board, id).item_status, close: () => store.closeBoard(board) };
}

test('a landing red in a file the item neither changed nor names in its check leaves it verified [C7,#2967]', async t => {
  const { close, state, entry, writes, status } = landing();
  t.after(close);
  assert.equal(await returnCulprit(state, entry, [FOREIGN]), false);
  assert.equal(status(), 'verified', 'the item stays verified');
  assert.ok(!writes.includes('reopen') && !writes.includes('appendFact'), 'nothing is written to the item');
  assert.deepEqual(state.culprits, [], 'the item is not a culprit');
  assert.deepEqual(state.batch.failures, [FOREIGN], 'the batch records the failure');
});

test('a landing red in a file the item changed reopens it with only its own failures [C7,#2967]', async t => {
  const { close, state, entry, status } = landing();
  t.after(close);
  const own = { file: OWN, name: 'own case' };
  assert.equal(await returnCulprit(state, entry, [FOREIGN, own]), true);
  assert.equal(status(), 'open');
  assert.deepEqual(state.culprits[0].tests, [own], 'the foreign red is not its evidence');
});

test('a landing red in a file only its check names reopens it [C7,#2967]', async t => {
  const { close, state, entry, status } = landing();
  t.after(close);
  assert.equal(await returnCulprit(state, entry, [{ file: NAMED, name: 'named case' }]), true);
  assert.equal(status(), 'open');
});

test('a landing infrastructure or diagnostic refusal reopens no item [C7,#2967]', async t => {
  const { close, state, writes, status } = landing();
  t.after(close);
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  for (const error of [new Refused('LAND_DIAGNOSTIC', 'a failing file could not be compared on base main'), new Refused('BOARD_BUSY', 'the board is busy'),
    new Refused('LAND_GATE_TIMEOUT', 'the gate timed out'), new Refused('RUNNER_SOURCE', 'the runner lost its source'),
    new Refused('LAND_MERGE', 'Git could not read the reviewed landing paths'), new Refused('LAND_CLI_SMOKE', 'the landing smoke could not prepare its scratch repository (git init): no space'), abort]) {
    assert.equal(await returnRefusedItem(state, error), false, error.code ?? error.name);
  }
  assert.equal(status(), 'verified');
  assert.deepEqual(writes, [], 'nothing is written');
});

test('a red static check on a one-item batch is the item\'s own and returns it whatever the trunk policy [C7,#2901,#2967]', async t => {
  const { close, state, status } = landing();
  t.after(close);
  const red = new Refused('GATE_RED', 'static checks are red; fix the named source before running proof:\nsrc/cockpit.js:1: prose command declaration differs from the CLI help catalog');
  assert.equal(itemRefusal(red), true, 'a static red names the candidate\'s source');
  const withPolicy = { ...state, config: { landing: { perItem: false } } };
  assert.equal(singleItemLanding(withPolicy), false, 'per-item is off for this batch');
  assert.equal(oneItemBatch(withPolicy), true, 'the batch still holds exactly one item');
  assert.equal(await returnRefusedItem(withPolicy, red), true);
  assert.equal(status(), 'open', 'the item goes back to its builder instead of being adopted again next wake');
});

test('a refusal of the item\'s own content still reopens it [C7,#2967]', async t => {
  const { close, state, status } = landing();
  t.after(close);
  assert.equal(await returnRefusedItem(state, new Refused('LAND_PLAN_UNPLACED', 'abc fails the cells-plan check')), true);
  assert.equal(status(), 'open');
});

test('BOARD_BUSY during a per-item landing leaves the item verified and is a landing fault, never a culprit [C7,#3068] clause 2', async t => {
  const { landingFault } = await import('../../../../../packages/landing/src/io/step/diagnose.js');
  const { close, state, writes, status } = landing();
  t.after(close);
  assert.equal(landingFault(new Refused('BOARD_BUSY', 'the board is busy')), true);
  assert.equal(landingFault(new Refused('LAND_HEADER', 'bad header')), false);
  assert.equal(await returnRefusedItem(state, new Refused('BOARD_BUSY', 'the board is busy')), false);
  assert.equal(status(), 'verified');
  assert.deepEqual(writes, []);
});

test('renewLocalLanding retries BOARD_BUSY with backoff until the acknowledged lease deadline, then gives up [C7,#3068] clause 1', async () => {
  const { renewWithBackoff } = await import('../../../../../packages/landing/src/io/resource.js');
  let at = 0;
  const pauses = [];
  const clock = { now: () => at, pausing: async ms => { pauses.push(ms); at += ms; }, until: () => 30_000 };
  let failures = 3;
  const renewed = await renewWithBackoff(() => { if (failures-- > 0) throw new Refused('BOARD_BUSY', 'busy'); return 'renewed'; }, clock);
  assert.equal(renewed, 'renewed');
  assert.deepEqual(pauses, [100, 200, 400]);
  at = 0;
  await assert.rejects(renewWithBackoff(() => { throw new Refused('BOARD_BUSY', 'busy'); }, clock), /busy/);
  assert.ok(at < 30_000 && at > 20_000, `gave up before the lease deadline after ${at} ms`);
  await assert.rejects(renewWithBackoff(() => { throw new Refused('LAND_LEASE_LOST', 'lost'); }, clock), /lost/);
});

test('a worker that gives up on BOARD_BUSY does not mark its batch blocked, so adoption resumes it [C7,#3068] clause 3', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../../../packages/landing/src/io/step/batch.js', import.meta.url), 'utf8');
  assert.match(source, /&& !landingFault\(error\)\s*\n\s*&& \['merging', 'gating'\]\.includes\(state\.batch\.state\)\)\) await save\(state, \{ state: 'blocked' \}\)/u);
});

test('a locked slot database is a landing fault, and the local trunk keeps its batch resumable [C7]', async () => {
  const { landingFault } = await import('../../../../../packages/landing/src/io/step/diagnose.js');
  assert.equal(landingFault(new Refused('SLOT_DB_LOCKED', 'never ran: the resource queue database stayed locked')), true);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../../../packages/landing/src/io/step/trunk.js', import.meta.url), 'utf8');
  const handler = /\} catch \(error\) \{\s*if \(!\(error instanceof Refused\)\) throw error;\s*[^\n]*\n\s*if \(landingFault\(error\)\) throw error;/u;
  assert.match(source, handler, 'a landing fault leaves the local trunk before it can save the batch blocked');
});
