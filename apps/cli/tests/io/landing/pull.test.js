/** landingOfferBatches cuts one offer's free items into jobs: sliced by size as before, or one job per item of the first parallel start group [C7,#9836]. */
// fixture-subject: addItem
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingOfferBatches } from '../../../src/io/landing/pull.js';
import { offerPulledLanding } from '../../../src/io/landing/pull.js';
import { acceptOrderOf } from '../../../src/io/landing/pull.js';
import { sweepDerivedState } from '../../../../../packages/health/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { createJob } from '../../../../../packages/jobs/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { mechanicalConflictFiles } from '../../../../../packages/merge/index.js';
import { mechanicalOnlyConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { realConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { underBoardWriteLock } from '../../../src/io/landing/pull.js';
import { offerOverConflict } from '../../fixtures/landing/conflict-offer.js';
import { offerWithLog } from '../../fixtures/landing/offer.js';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../fixtures/board.js';
import { temporaryDirectory } from '../../fixtures/board.js';

/** Accepted entries in accept order: #1 and #2 are disjoint, #3 shares #1's file, #4 shares #2's test. */
const free = [
  { id: 1, files: ['a.js', 'a.test.js'], tests: ['a.test.js'] },
  { id: 2, files: ['b.js', 'b.test.js'], tests: ['b.test.js'] },
  { id: 3, files: ['a.js'], tests: [] },
  { id: 4, files: ['d.js'], tests: ['b.test.js'] },
];

test('cli.io-landing-pull.parallel-on-offers-group: clause 1: with parallel on, one single-item batch per id of the first start group, so disjoint items are offered together and items sharing a file or test are not [C7,#9836]', () => {
  const batches = landingOfferBatches(free, { size: 4, parallel: true });
  assert.deepEqual(batches.map(batch => batch.map(entry => entry.id)), [[1], [2]]);
  assert.equal(batches[0][0], free[0], 'the entry itself is offered');
  assert.deepEqual(landingOfferBatches([free[0], free[2]], { size: 4, parallel: true }).map(batch => batch[0].id), [1], 'a shared file keeps #3 out');
  assert.deepEqual(landingOfferBatches([free[1], free[3]], { size: 4, parallel: true }).map(batch => batch[0].id), [2], 'a shared test keeps #4 out');
  assert.deepEqual(landingOfferBatches([], { size: 4, parallel: true }), []);
});

test('cli.io-landing-pull.parallel-off-as-today: clause 2: with parallel off, free is cut into batches of size exactly as the slice loop on main does [C7,#9836]', () => {
  assert.deepEqual(landingOfferBatches(free, { size: 3 }).map(batch => batch.map(entry => entry.id)), [[1, 2, 3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 1, parallel: false }).map(batch => batch.map(entry => entry.id)), [[1], [2], [3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 4, parallel: false }).map(batch => batch.length), [4]);
  assert.deepEqual(landingOfferBatches([], { size: 2 }), []);
});

test('cli.io-landing-pull.conflict-repos-mechanical-only: clause 1: the conflict-repos helper builds a mechanical-only conflict [C7,#3064]', () => {
  const { root, main, head } = mechanicalOnlyConflictRepo();
  assert.deepEqual(mechanicalConflictFiles(root, main, head), []);
  assert.deepEqual(mechanicalConflictFiles(root, head, main), []);
});

test('cli.io-landing-pull.conflict-repos-real: clause 2: the conflict-repos helper builds a real conflict [C7,#3064]', () => {
  const { root, main, head, file } = realConflictRepo();
  assert.deepEqual(mechanicalConflictFiles(root, main, head), [file]);
});

/** A real file board whose machine logs go to a private home; returns the board, its holder folder and a reader of board-writes.jsonl. */
function lockedBoard(t) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = temporaryDirectory('pullboard-offer-lock-');
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = realpathSync(board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file);
  const holders = () => existsSync(file + '.write-holders') ? readdirSync(file + '.write-holders') : [];
  const rows = () => existsSync(join(home, 'board-writes.jsonl')) ? readFileSync(join(home, 'board-writes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { board, holders, rows };
}

test('cli.io-landing-pull.offer-lock-records-hold: clause 1: an offer through underBoardWriteLock() appends one row to the machine board-writes.jsonl naming its command, pid and outcome [C7,#11027]', t => {
  const { board, rows } = lockedBoard(t);
  assert.equal(underBoardWriteLock(board, () => 'offered'), 'offered');
  const offers = () => rows().filter(row => row.move === 'offerPulledLanding');
  const [row, ...rest] = offers();
  assert.deepEqual(rest, [], 'one row for one offer');
  assert.equal(row.move, 'offerPulledLanding');
  assert.equal(row.pid, process.pid);
  assert.equal(row.outcome, 'committed');
  assert.ok(typeof row.command === 'string' && row.command.length > 0);
  assert.throws(() => underBoardWriteLock(board, () => { throw new Error('refused offer'); }), /refused offer/u);
  assert.deepEqual(offers().map(entry => entry.outcome), ['committed', 'rolled-back']);
});

test('cli.io-landing-pull.offer-lock-marks-holder: clause 2: while the offer holds the lock the board write-holders folder has its marker, and it is gone after commit or rollback [C7,#11027]', t => {
  const { board, holders } = lockedBoard(t);
  let during = [];
  underBoardWriteLock(board, () => { during = holders(); });
  assert.equal(during.length, 1, 'the marker exists while the lock is held');
  assert.ok(during[0].startsWith(`${process.pid}-`));
  assert.deepEqual(holders(), [], 'gone after commit');
  assert.throws(() => underBoardWriteLock(board, () => { throw new Error('refused offer'); }), /refused offer/u);
  assert.deepEqual(holders(), [], 'gone after rollback');
});

test('cli.io-landing-pull.git-outside-offer-lock: clause 1: offerPulledLanding with parallelGates on starts no git child process while its injected board write lock is held [C7,#11105]', async t => {
  const { result, lines, jobs } = await offerWithLog(t);
  const enter = lines.indexOf('LOCK_ENTER'), exit = lines.indexOf('LOCK_EXIT');
  assert.ok(enter >= 0 && exit > enter, `the offer went through the injected lock: ${lines.join(' | ')}`);
  assert.deepEqual(lines.slice(enter, exit).filter(line => line.startsWith('git ')), [], 'no git starts between lock enter and lock exit');
  assert.ok(lines.slice(0, enter).filter(line => line.startsWith('git ')).length > 0, 'the git reads still happen, before the lock');
  assert.equal(jobs.length, 2, 'the offer was written');
  assert.ok(result.offered);
});

test('cli.io-landing-pull.offer-unchanged-outside-lock: clause 2: the offered job carries the same items, files, tests and flakes as when the reads ran inside the lock, and an item a concurrent offer took is still left out [C7,#11105]', async t => {
  const plain = await offerWithLog(t);
  // Disjoint files and tests: parallel gates offer one single-item job per item; each carries its own flakes prefixes.
  assert.deepEqual(plain.jobs.map(job => job.items.map(entry => entry.id)), [[1], [2]]);
  for (const job of plain.jobs) assert.deepEqual(job.flakes, { rerun: true, prefixes: { check: 'prefix', proof: 'prefix' } });
  assert.deepEqual(plain.result.items, [1, 2]);
  const raced = await offerWithLog(t, { concurrentOffer: true });
  // #2 was offered by the concurrent accept before this offer's lock; this offer adds a job for #1 only.
  assert.deepEqual(raced.jobs.map(job => job.items.map(entry => entry.id)).sort(), [[1], [2]]);
  assert.deepEqual(raced.result.items, [1], 'only #1 is left to this offer');
});

/** A verdict row the sweep stores for a plain stale verdict: the file a main change touched and the commit that changed it. */
const staleRow = main => ({ code: 'STALE_VERDICT', file: 'a.js', commit: main });

test('cli.io-landing-pull.table-staleness-reopens: clause 1: with health.derivedState on and a table current for main, an item the table marks stale goes back to its lane and a fresh one is offered, though git alone finds both fresh [C7,#3010]', async t => {
  const { board, jobs, result } = await offerWithLog(t, { derived: { verdicts: { 1: staleRow('1'.repeat(40)) } } });
  assert.equal(store.getItem(board, 1).item_status, 'open', 'the stale one returned to its lane');
  assert.equal(store.getItem(board, 2).item_status, 'verified');
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2]], 'only the fresh one is offered');
  assert.deepEqual(result.items, [2]);
});

test('cli.io-landing-pull.table-not-current-computes: clause 2: with a table swept at an older main, or with the setting off, freshness is computed as on main and both items are offered [C7,#3010]', async t => {
  for (const derived of [{ swept: 'older', verdicts: { 1: staleRow('1'.repeat(40)) } }, { setting: false, verdicts: { 1: staleRow('1'.repeat(40)) } }]) {
    const { board, jobs } = await offerWithLog(t, { derived });
    assert.equal(store.getItem(board, 1).item_status, 'verified', JSON.stringify(derived));
    assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[1], [2]], JSON.stringify(derived));
  }
});

test('cli.io-landing-pull.table-wired-into-offer: clause 3: production wiring: offerPulledLanding hands the table verdicts to withoutStaleVerdicts, so a current table offers the same items with fewer git starts before the lock than the setting off [C7,#3010]', async t => {
  const off = await offerWithLog(t, { derived: { setting: false } });
  const on = await offerWithLog(t, { derived: {} });
  assert.deepEqual(on.jobs.map(job => job.items.map(entry => entry.id)), off.jobs.map(job => job.items.map(entry => entry.id)));
  assert.ok(on.beforeLock < off.beforeLock, `git starts before the lock: ${on.beforeLock} with the table, ${off.beforeLock} without`);
});

test('cli.io-landing-pull.step-aside-head-goes-behind: clause 1: offerPulledLanding offers an accepted item with 2 infrastructure failures behind the next accepted item [C7,#3118]', async t => {
  const { jobs, result } = await offerWithLog(t, { lapses: { 1: 2 } });
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2], [1]], 'the head with two failures goes behind #2');
  assert.deepEqual(result.items, [2, 1]);
});

test('cli.io-landing-pull.step-aside-one-failure-keeps-order: clause 2: one infrastructure failure keeps the accept-order place, and named ids keep the order named [C7,#3118]', async t => {
  const one = await offerWithLog(t, { lapses: { 1: 1 } });
  assert.deepEqual(one.jobs.map(job => job.items.map(entry => entry.id)), [[1], [2]], 'one failure keeps the place');
  const none = await offerWithLog(t, { lapses: {} });
  assert.deepEqual(none.result.items, [1, 2]);
});

test('cli.io-landing-pull.step-aside-on-the-real-pull-path: clause 3: the step-aside cases drive offerPulledLanding on the real pull path, which reads store.stepAsideCount, not candidates() [C7,#3118]', async t => {
  // A count past 2 also goes behind; the order comes from the offer's written jobs, so the pull path itself applied the rule.
  const { jobs } = await offerWithLog(t, { lapses: { 1: 3 } });
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2], [1]]);
});

test('cli.io-landing-pull.step-aside-says-why: clause 1: offerPulledLanding says one line naming the stepped-aside head and its infrastructure-failure count [C7,#3118]', async t => {
  const { said } = await offerWithLog(t, { lapses: { 1: 2 } });
  assert.deepEqual(said.filter(line => /steps aside/u.test(line)), ['#1 steps aside: 2 infrastructure failures, offered behind the next accepted item']);
  const quiet = await offerWithLog(t, { lapses: { 1: 1 } });
  assert.deepEqual(quiet.said.filter(line => /steps aside/u.test(line)), [], 'one failure is not a step aside, so nothing is said');
});

test('cli.io-landing-pull.own-red-head-stays-held: clause 2: a head held after a red on its own tests is not offered and not counted as stepped aside [C7,#3118]', async t => {
  const { jobs, result, said } = await offerWithLog(t, { held: [1] });
  assert.deepEqual(result.items, [2], 'the held head is not offered');
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2]]);
  assert.deepEqual(said.filter(line => /steps aside/u.test(line)), []);
});

test('cli.io-landing-pull.mechanical-only-conflict-stays-verified: clause 1: a mechanical-only conflict keeps the accepted item verified and the offer takes it [C7,#3064]', async t => {
  const { result, said, item } = await offerOverConflict(t, mechanicalOnlyConflictRepo());
  assert.equal(item.item_status, 'verified', said.join('\n'));
  assert.deepEqual(result?.items, [item.item_id]);
  assert.doesNotMatch(said.join('\n'), /STALE_VERDICT/u);
});

test('cli.io-landing-pull.real-conflict-reopens-naming-file: clause 2: a real conflict still reopens the accepted item naming the file [C7,#3064]', async t => {
  const repo = realConflictRepo();
  const { result, said, item } = await offerOverConflict(t, repo);
  assert.equal(item.item_status, 'open');
  assert.match(said.join('\n'), new RegExp(`STALE_VERDICT #${item.item_id} reopened to its lane: ${repo.file.replace('.', '\\.')}`, 'u'));
  assert.deepEqual(result?.items ?? [], []);
});

const SWEPT = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

/** A file board with two accepted unlanded items, #second accepted before #first, swept at SWEPT with a table order the events do not give; returns the board, both ids and the SQL its prepares saw. */
function acceptedBoard(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const [first, second] = [1, 2].map(n => addItem(board, { by: 'coordinator', lane: 'web', title: `Accepted item ${n}` }));
  const accept = id => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  accept(second);
  accept(first);
  const listItems = () => board.db.prepare('SELECT * FROM item ORDER BY item_id').all().map(item => ({ ...item, item_status: 'verified' }));
  sweepDerivedState(board, { mainCommit: SWEPT, enabled: true, listItems, verdictState: () => null, gateAtHead: () => null });
  const sql = [];
  const prepare = board.db.prepare.bind(board.db);
  board.db.prepare = text => { sql.push(text); return prepare(text); };
  return { board, first, second, sql };
}

test('cli.io-landing-pull.accept-order-from-table: clause 1: with health.derivedState on and a table current for main, the offer orders accepted items by the table accept order and runs no GROUP BY scan of accept events [C7,#11381]', async t => {
  const { board, first, second, sql } = acceptedBoard(t);
  const order = await acceptOrderOf('/unused', board, [first, second], { enabled: true, mainCommit: SWEPT });
  assert.deepEqual([...order.keys()].sort((a, b) => order.get(a) - order.get(b)), [second, first], 'the table orders #2 (accepted first) before #1');
  assert.ok(!sql.some(text => /GROUP BY/i.test(text)), 'no accept-event scan ran');
});

test('cli.io-landing-pull.accept-order-as-on-main: clause 2: with a table swept at an older main, or with the setting off, the offer orders items exactly as on main from the accept events [C7,#11381]', async t => {
  const { board, first, second, sql } = acceptedBoard(t);
  const scanned = [...(await acceptOrderOf('/unused', board, [first, second], { enabled: false })).entries()];
  assert.deepEqual(scanned.sort((a, b) => a[1] - b[1]).map(([id]) => id), [second, first]);
  assert.ok(sql.some(text => /GROUP BY/i.test(text)), 'the setting off scans the events');
  sql.length = 0;
  const stale = [...(await acceptOrderOf('/unused', board, [first, second], { enabled: true, mainCommit: MOVED })).entries()];
  assert.deepEqual(stale.sort((a, b) => a[1] - b[1]), scanned, 'a table swept at an older main is not read');
  assert.ok(sql.some(text => /GROUP BY/i.test(text)), 'the older table scans the events');
});

test('cli.io-landing-pull.accept-order-production-wiring: clause 3: the offer reads acceptOrderOf in place of its accept-event query, and acceptOrderOf reads readDerivedState [C7,#11381]', () => {
  assert.match(offerPulledLanding.toString(), /await acceptOrderOf\(root, board,/);
  assert.doesNotMatch(offerPulledLanding.toString(), /GROUP BY/);
  assert.match(acceptOrderOf.toString(), /readDerivedState\(board, \{ mainCommit: main, enabled: true \}\)/);
});

test('cli.landing-pull.items-carry-pace: clause 1: a landing offered for one item frozen at sprint and one at steady carries each item pace in its job payload [V2,M1,#12227]', async t => {
  const { jobs } = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' } });
  const paceOf = id => jobs.flatMap(job => job.items).find(entry => entry.id === id)?.pace;
  assert.equal(paceOf(1), 'sprint');
  assert.equal(paceOf(2), 'steady');
});

test('cli.landing-pull.payload-sprint-plan: clause 1: a landing offered for a sprint item carries payload.sprint { static, testCommand, testFiles } built from the configured static check and affected-tests command, and a landing of steady items only carries no sprint key [V2,M1,#12229]', async t => {
  const config = { staticChecks: 'npm run static', affectedTests: 'node --test' };
  const sprint = (await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' }, config })).jobs.map(job => job.sprint).find(Boolean);
  assert.deepEqual(sprint.static, ['sh', '-c', 'npm run static']);
  assert.equal(sprint.testCommand.slice(0, 2).join(' '), 'sh -c');
  assert.match(sprint.testCommand[2], /node --test "\$@"$/u);
  assert.match('packages/demo/tests/ok.test.js', new RegExp(sprint.testFiles, 'u'));
  const bare = (await offerWithLog(t, { paces: { 1: 'sprint' } })).jobs.map(job => job.sprint).find(Boolean);
  assert.equal(bare.static, null);
  assert.deepEqual(bare.testCommand, ['false']);
  const steady = await offerWithLog(t, { paces: { 1: 'steady', 2: 'steady' }, config });
  assert.equal(steady.jobs.some(job => 'sprint' in job), false);
});

/** A post-land main-wide test job on the board: one id per landed tip, offered carrying `items`; finished with a red or green receipt unless `receipt` is null. */
function postLandJob(board, { tip, items, receipt, now }) {
  const job = `post-land:${tip.repeat(40).slice(0, 40)}`;
  createJob(board.db, { id: job, kind: 'test', candidate: tip.repeat(40).slice(0, 40), base: tip.repeat(40).slice(0, 40), now });
  writeStep(board.db, job, 'offered', { needs: [], payload: { postLand: { job: 'land:fixture', items } } }, { now });
  if (!receipt) return job;
  const red = receipt === 'red';
  writeStep(board.db, job, 'receipt', { runner: 'r-fixture', attempt: 1, receipt: { version: 1, status: red ? 1 : 0, outcome: receipt, gate: { green: !red, phases: [{ status: red ? 1 : 0, failures: [] }] } } }, { seq: 1, now });
  board.db.prepare("UPDATE job SET job_step = 'done' WHERE job_id = ?").run(job);
  return job;
}

/** A sprint item the red job reopened: item 3 on the board with its pull_out recorded, and its pulled event too when `pulled`. */
function pullingItem(board, { pulled = false } = {}) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'landed sprint work the red main reopened' });
  store.atomic(board, () => store.logEvent(board, 'coordinator', 'pull_out', id, { commit: 'c'.repeat(40), mergedCommit: 'd'.repeat(40) }));
  if (pulled) store.atomic(board, () => store.logEvent(board, 'coordinator', 'pulled', id, { commit: 'e'.repeat(40) }));
  return id;
}

/** The ids the offer put into land jobs. */
const offeredIds = jobs => jobs.flatMap(job => job.items.map(entry => entry.id)).sort();

test('cli.landing.pull.sprint-holds-on-red-main: clause 1: while the newest finished post-land job is red with its item not yet pulled, the offer sends no sprint item and says MAIN_RED naming that job, a steady item goes as before, and a pending job never holds [C7,V2,M1,#12502]', async t => {
  let red;
  const held = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' }, before: ({ board }) => {
    const id = pullingItem(board);
    red = postLandJob(board, { tip: 'a', items: [id], receipt: 'red', now: 10 });
  } });
  assert.deepEqual(offeredIds(held.jobs), [2], 'only the steady item is offered');
  assert.ok(held.said.some(line => line.startsWith('#1 waits: MAIN_RED on ' + red)), `the offer names the red job: ${held.said.join(' | ')}`);
  // A newer pending job is ignored: the last finished result still holds.
  const pending = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' }, before: ({ board }) => {
    const id = pullingItem(board);
    postLandJob(board, { tip: 'a', items: [id], receipt: 'red', now: 10 });
    postLandJob(board, { tip: 'b', items: [], receipt: null, now: 20 });
  } });
  assert.deepEqual(offeredIds(pending.jobs), [2], 'a pending newer job leaves the red one in force');
  // A board whose only post-land job is pending holds nothing.
  const only = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'sprint' }, before: ({ board }) => { postLandJob(board, { tip: 'b', items: [], receipt: null, now: 20 }); } });
  assert.deepEqual(offeredIds(only.jobs), [1, 2], 'a pending or stuck job never holds sprint');
});

test('cli.landing.pull.sprint-resumes-after-green-or-pulled: clause 1: once the red job items are each pulled, or a later finished post-land job is green, the next offer sends the sprint item [C7,V2,M1,#12502]', async t => {
  const pulled = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' }, before: ({ board }) => {
    postLandJob(board, { tip: 'a', items: [pullingItem(board, { pulled: true })], receipt: 'red', now: 10 });
  } });
  assert.deepEqual(offeredIds(pulled.jobs), [1, 2], 'a pulled red job holds nothing');
  const green = await offerWithLog(t, { paces: { 1: 'sprint', 2: 'steady' }, before: ({ board }) => {
    postLandJob(board, { tip: 'a', items: [pullingItem(board)], receipt: 'red', now: 10 });
    postLandJob(board, { tip: 'b', items: [], receipt: 'green', now: 20 });
  } });
  assert.deepEqual(offeredIds(green.jobs), [1, 2], 'a later finished green job lifts the hold');
});

/** The ledger setting on, as pullboard.json sets it on the live board; main reds ride with the contracts, so an affected-tests runner is set too. */
const AFFECTED = { affectedTests: 'node affected.js' };
const LEDGER_ON = { ...AFFECTED, landing: { ledgerMainReds: true } };

test('cli.io-landing-pull.ledger-outside-offer-lock: clause 1: with landing.ledgerMainReds on, offerPulledLanding prepares no test_result statement while its board write lock is held; the red-now ledger read runs before the lock [C7,#12533]', async t => {
  // The setting alone: an affectedTests runner adds landingProof's commit-indexed ledger reads to the job write, which this case does not cover.
  const { lines, jobs } = await offerWithLog(t, { config: { landing: { ledgerMainReds: true } }, ledger: { reds: ['tests/red.test.js'] } });
  const enter = lines.indexOf('LOCK_ENTER'), exit = lines.indexOf('LOCK_EXIT');
  assert.ok(enter >= 0 && exit > enter, `the offer went through the injected lock: ${lines.join(' | ')}`);
  assert.deepEqual(lines.slice(enter, exit).filter(line => line === 'SQL test_result'), [], 'no test_result statement between lock enter and lock exit');
  assert.ok(lines.slice(0, enter).includes('SQL test_result'), 'the ledger read still happens, before the lock');
  assert.equal(jobs.length, 2, 'the offer was written');
});

test('cli.io-landing-pull.ledger-main-reds-unchanged: clause 2: with a red ledger row seeded at a commit, the offered land job carries the same mainReds pair it carried on main, and none with the setting off [C7,#12533]', async t => {
  const on = await offerWithLog(t, { config: LEDGER_ON, ledger: { reds: ['tests/red.test.js'], filler: 3 } });
  assert.equal(on.jobs.length, 2);
  for (const job of on.jobs) assert.deepEqual(job.mainReds, [['tests/red.test.js', on.main]], 'each job carries the red file and the commit it was red at');
  const off = await offerWithLog(t, { config: AFFECTED, ledger: { reds: ['tests/red.test.js'] } });
  for (const job of off.jobs) assert.deepEqual(job.mainReds ?? [], [], 'with the setting off no job carries a main red');
});

test('cli.io-landing-pull.offer-hold-under-1s: clause 3: with 200,000 test_result rows seeded and ledgerMainReds on, the offer board-writes.jsonl hold row (move offerPulledLanding) records heldMs under 1000 [C7,#12533]', async t => {
  const { home, jobs, main } = await offerWithLog(t, { config: LEDGER_ON, ledger: { reds: ['tests/red.test.js'], filler: 200_000 } });
  assert.equal(jobs.length, 2, 'the offer was written');
  assert.deepEqual(jobs[0].mainReds, [['tests/red.test.js', main]], 'the big ledger was still read');
  const holds = readFileSync(join(home, 'board-writes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.move === 'offerPulledLanding');
  assert.equal(holds.length, 1, 'one hold row for the one offer');
  assert.ok(holds[0].heldMs < 1000, `the offer held the board write lock ${holds[0].heldMs} ms`);
});
