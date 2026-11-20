/** The pendingSubmitHandoff readers (routing, take, the merge-conflict guard) read the runner job row with submit.pendingFromJobRow on, and not with it off [C7,P7,#9741]. @pullboard-test-input source-cell apps/cli */
// fixture-subject: addItem (a store-level unit of the pending-hand-off readers over one waiting claim; no kit seam builds an offered gate job row beside a claim)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { endJob } from '../../../../../../packages/jobs/index.js';
import { pendingFromJobRow } from '../../../../../../packages/config/index.js';
import { defaults } from '../../../../../../packages/config/index.js';
import { mainRedBuildRouting } from '../../../../../../packages/store/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { nextTake } from '../../../../../../packages/sandbox/index.js';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureBoard } from '../../../fixtures/board.js';
import { offerGateJob } from '../../../../src/io/submit/pull.js';

const MAIN = 'a'.repeat(40);
const SOURCE = 'b'.repeat(40);

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-pending-readers-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The same async read, with the machine home restored once it settles. */
async function withSettingsAsync(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-pending-readers-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return await read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A board whose one seat holds a claim waiting on an unmet prerequisite, with an urgent repair open, as main-red routing needs. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/private/readers-main' });
  const seat = store.register(board, { lane: 'web', path: '/private/readers-builder', route: 'strong' });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'Readers see the job row. [test]', check: 'true' });
  const waiting = add('Held waiting work');
  store.claim(board, waiting, { agentId: seat, lane: 'web', leaseMs: 7_200_000, freeze: item => ({ text: item.item_title, digest: 'private-readers' }) });
  store.editItem(board, waiting, { agentId: 'coordinator', after: [add('Blocking prerequisite')] });
  const repair = add('Emergency work');
  store.appendFact(board, repair, { agentId: 'coordinator', kind: 'urgent', text: 'on', asPerson: true, channel: 'view' });
  const job = () => offerGateJob(board.db, { item: waiting, main: MAIN, source: SOURCE, request: {} });
  return { board, seat, waiting, repair, job, clean: new Map([[waiting, { files: [], unknown: false }]]) };
}

test('cli.journeys-submit-pending-readers.pendingsubmithandoff-is-true-for-an-offered: clause 1: pendingSubmitHandoff is true for an offered gate job row with the setting on, false with it off, and false once the job ends [C7,P7,#9741]', t => {
  const f = fixture(t);
  const held = () => store.getItem(f.board, f.waiting);
  assert.equal(withSettings({}, pendingFromJobRow), false, 'the setting is off by default');
  assert.ok(!store.pendingSubmitHandoff(f.board, held(), { fromJobRow: true }), 'no job row, nothing pending');
  const job = f.job();
  assert.equal(job.step, 'offered');
  assert.ok(!store.pendingSubmitHandoff(f.board, held()), 'with the setting off the offered row is not read');
  assert.ok(!store.pendingSubmitHandoff(f.board, held(), { fromJobRow: false }));
  const pending = store.pendingSubmitHandoff(f.board, held(), { fromJobRow: true });
  assert.equal(pending?.state, 'queued', 'with the setting on the offered row is pending');
  assert.equal(pending.agentId, f.seat);
  assert.equal(endJob(f.board.db, job.id, 'withdrawn'), true);
  assert.ok(!store.pendingSubmitHandoff(f.board, held(), { fromJobRow: true }), 'an ended job is no longer pending');
});

test('cli.journeys-submit-pending-readers.routing-keeps-a-claim-whose-gate: clause 1: routing keeps a claim whose gate job row is offered, and only with the setting on [C7,P7,#9741]', t => {
  const f = fixture(t);
  const route = pendingFromJobRow => mainRedBuildRouting(f.board, { caller: f.seat, workingFiles: f.clean, pendingFromJobRow });
  const job = f.job();
  assert.equal(route(false)?.releaseRequest?.item, f.waiting, 'with the setting off the waiting claim is asked to yield, as today');
  assert.equal(route(true), null, 'with the setting on the offered gate job row keeps the claim');
  endJob(f.board.db, job.id, 'withdrawn');
  assert.equal(route(true)?.releaseRequest?.item, f.waiting, 'once the job ends the claim yields again');
});

test('cli.journeys-submit-pending-readers.take-reads-the-offered-job-row: clause 2: take reads the offered job row for its own claim only with the setting on [C7,P7,#9741]', async t => {
  const f = fixture(t);
  f.job();
  const services = {
    checkMainVerifier() {}, whoAmI: () => ({ id: f.seat, lane: 'web' }),
    mainRedReworkItems: () => [], mainRedReviewItems: () => [], agentSessionDigest: () => 'private-test',
    claimWorktrees: () => f.clean,
    withBoardRead: (_ctx, work) => work(f.board), withBoard: async (_ctx, work) => work(f.board),
    ordered: async (_ctx, board, operation, args) => store[operation](board, ...args),
  };
  const take = () => nextTake({ info: { root: '/private/readers-builder' }, config: defaults(), clock: f.board.clock, io: {} }, {}, services);
  const kept = await withSettingsAsync({ submit: { pendingFromJobRow: true } }, take);
  assert.notEqual(kept?.retryDetail?.code, 'WAITING_CLAIM_RELEASED', 'with the setting on the claim waits on its offered gate');
  assert.equal(store.getItem(f.board, f.waiting).item_status, 'claimed');
  const released = await withSettingsAsync({}, take);
  assert.equal(released.retryDetail.code, 'WAITING_CLAIM_RELEASED', 'with the setting off the claim yields, as today');
  assert.equal(store.getItem(f.board, f.waiting).item_status, 'open');
});

test('cli.journeys-submit-pending-readers.the-merge-conflict-guard-reads-the: clause 2: the merge-conflict guard reads the offered job row through the setting it is given, true while offered and false once ended [C7,P7,#9741]', t => {
  const f = fixture(t);
  const guard = () => withSettings({ submit: { pendingFromJobRow: true } }, () => store.pendingSubmitHandoff(f.board, store.getItem(f.board, f.waiting), { fromJobRow: pendingFromJobRow() }));
  const job = f.job();
  assert.ok(guard(), 'an offered gate job row reads as the original source already queued');
  endJob(f.board.db, job.id, 'withdrawn');
  assert.ok(!guard(), 'an ended job does not');
  assert.ok(!withSettings({}, () => store.pendingSubmitHandoff(f.board, store.getItem(f.board, f.waiting), { fromJobRow: pendingFromJobRow() })), 'with the setting off the guard is unchanged');
});
