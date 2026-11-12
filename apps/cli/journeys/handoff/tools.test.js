/** A queued gate ticket whose captured tools are gone never stops the handoff dispatcher; its gate stops on infrastructure and is requeued [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../../../../packages/resources/index.js';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  drainHandoffQueue,
  handoffQueueDirectory,
  queueHandoffLaunch,
  reserveHandoffTicket,
} from '../../../../packages/resources/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  endedSubmitHandoff,
  getItem,
  submitHandoff,
} from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { gateAdmission } from '../../../lib/src/io/handoff/dispatcher.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** A real worker that records its own start and exits. */
const WORKER = `const { writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
writeFileSync(join(dirname(process.argv[2]), 'result.json'), 'started');
`;

/** Launch tickets still waiting in the machine queue. */
function tickets() { return readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)); }

/** Point the machine home at a private directory for one test. */
function machineHome(t, home) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
}

test('a ticket whose tools folder is gone is ended as infrastructure and the dispatcher starts the next ticket [C7]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-missing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  machineHome(t, join(dir, 'home'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const jobs = ['lost', 'next'].map(id => {
    const directory = join(dir, 'jobs', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: id }) + '\n');
    return { id, directory };
  });
  queueHandoffLaunch({ directory: jobs[0].directory, tools: join(dir, 'removed-by-temp-cleanup'), commonDir: dir, job: 'lost' }, await reserveHandoffTicket('lost'));
  queueHandoffLaunch({ directory: jobs[1].directory, tools, commonDir: dir, job: 'next' }, await reserveHandoffTicket('next'));
  // The admission records each gate's driver on its board; here it records the calls the dispatcher made [C7].
  const calls = [];
  const admission = { admit: (launch, detail) => calls.push(['admit', launch.job, detail]), spawned: (launch, detail) => calls.push(['spawned', launch.job, detail]),
    unstarted: (launch, detail) => calls.push(['unstarted', launch.job, detail]), entry: null };
  const { started } = await drainHandoffQueue({ capacity: 1, pollMs: 20, admission });
  assert.deepEqual(started, ['next'], 'the dispatcher carried on past the lost ticket');
  assert.equal(readFileSync(join(jobs[1].directory, 'result.json'), 'utf8'), 'started');
  const unstarted = calls.filter(([kind]) => kind === 'unstarted');
  assert.equal(unstarted.length, 1);
  assert.equal(unstarted[0][1], 'lost');
  assert.equal(unstarted[0][2].code, 'ENOENT', 'the lost worker is recorded as never started');
  assert.equal(unstarted[0][2].owner, calls.find(([kind, job]) => kind === 'admit' && job === 'lost')[2].owner, 'under the driver id it was admitted to');
  assert.equal(existsSync(join(jobs[0].directory, 'worker.json')), false, 'nothing is written beside the hand-off');
  assert.deepEqual(tickets(), [], 'no ticket is left to block the queue');
});

/** Read the real board state the commands wrote. */
function state(box, id) {
  // @pullboard-board-file journey: observe the persisted queue record after the dispatcher and sweep ran.
  const board = openBoard(box.boardFile);
  try {
    const job = submitHandoff(board, id);
    return { item: getItem(board, id), job, previous: job?.retryOf ? endedSubmitHandoff(board, job.retryOf) : null,
      gates: board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind='gate' AND job_item=?").get(id).n,
      returns: board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='submit_handoff_returned'").get(id).n };
  }
  finally { board.db.close(); }
}

test('a queued gate whose tools temp cleanup removed gets an infrastructure stop, never a red [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  machineHome(t, isolated.env.PULLBOARD_MACHINE_HOME);
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Lost tools', '--specs', 'G1', '--criterion', 'A lost gate stops on infrastructure.', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/lost.txt', 'lost\n', 'feat(web): lost candidate [G1]').status, 0);
  // Hold the dispatcher seat so the ticket waits in the queue, as the 100 lost tickets did.
  const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'test-dispatcher' });
  let job;
  try {
    const submitted = await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json');
    assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
    job = state(box, id).job;
    assert.equal(job.state, 'queued');
    const request = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'request.json'), 'utf8'));
    rmSync(request.tools, { recursive: true, force: true });
    assert.equal(existsSync(request.tools), false);
  } finally { lock.release(); }
  // The production admission: the gate's drive job records that its driver never started [C7].
  await drainHandoffQueue({ capacity: 1, pollMs: 20, admission: gateAdmission });
  // Hold the dispatcher seat again, so the requeued gate waits in line where the test can read it instead of running.
  const held = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'test-dispatcher' });
  let after;
  try {
    const sweep = await box.runLocal(box.repo, 'sentinel', 'run', '--health-only');
    assert.equal(sweep.code, 0, `${sweep.err}\n${sweep.out}`);
    after = state(box, id);
  } finally { held.release(); }
  // A healthy sweep requeues the lost gate's exact candidate as a fresh gate, its tools rebuilt from the captured commit (#3716, #3714).
  assert.notEqual(after.job.id, job.id, 'the stopped gate is requeued as a fresh job');
  assert.equal(after.job.retryOf, job.id, 'the fresh job names the lost gate');
  assert.equal(after.job.state, 'queued');
  // The lost gate itself stopped on infrastructure with SUBMIT_HANDOFF_DEAD, never a red.
  assert.equal(after.previous?.id, job.id);
  assert.equal(after.previous.state, 'infrastructure', 'the lost gate stops on infrastructure');
  assert.equal(after.previous.error.code, 'SUBMIT_HANDOFF_DEAD');
  // Exactly one requeue: one infrastructure retry spent, and two gate jobs for the item, the lost one and its requeue.
  assert.equal(after.job.infrastructureRetries, 1, 'one infrastructure retry is spent');
  assert.equal(after.gates, 2, 'only one requeue happened');
  assert.deepEqual([after.job.commit, after.job.tree, after.job.digest], [job.commit, job.tree, job.digest], 'from the same captured candidate and bar');
  const retried = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', after.job.id, 'request.json'), 'utf8'));
  assert.equal(existsSync(retried.tools), true, 'the requeued gate has its tools back');
  assert.ok(tickets().some(name => name.includes(after.job.id)), 'the requeued gate waits in the dispatch queue');
  assert.equal(after.item.item_status, 'claimed', 'the builder keeps the item to resubmit');
  assert.equal(after.returns, 0, 'no builder red is recorded');
});
