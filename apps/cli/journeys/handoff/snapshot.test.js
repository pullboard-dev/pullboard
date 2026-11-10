/** Every gate at one Pullboard commit runs from one shared tools snapshot, never a copy per submit [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { setDriverUnstarted } from '../../tests/fixtures/gate/driver.js';
import { test } from 'node:test';
import { removeJobToolSnapshot } from '../../../../packages/items/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  handoffQueueDirectory,
  takeResource,
} from '../../../../packages/resources/index.js';
import {
  getItem,
  submitHandoff,
} from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  assertToolTreeRoom,
  sweepToolTrees,
  queuedToolOwners,
} from '../../../../packages/items/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

/** Require authentic command success before interpreting its result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the persisted queue record the command wrote. */
function jobOf(box, id) {
  // @pullboard-board-file journey: observe the persisted queue record after each real submit.
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** The tools folders currently in the isolated temp directory. */
function snapshots(temp) { return readdirSync(temp).filter(name => name.startsWith('pullboard-handoff-tools-')); }

/** A fixture board whose temp dir is private, whose tooling is a clean clone of this commit, and whose dispatcher is held so gates stay queued. */
async function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-shared-tools-')));
  isolated.env.TMPDIR = temp;
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = isolated.env.PULLBOARD_MACHINE_HOME;
  const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'test-dispatcher' });
  t.after(() => {
    lock.release();
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    helpers.cleanup();
    rmSync(temp, { recursive: true, force: true });
  });
  // A clean clone of the running commit: the shared snapshot needs a committed, unmodified tooling tree.
  const tools = join(temp, 'tooling');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, tools], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  /** Run a command with the cloned tooling instead of this checkout. */
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [join(tools, 'apps/cli/pullboard.js'), ...args], { cwd, env: box.env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr };
  };
  const toolsCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tools, encoding: 'utf8' }).trim();
  return { ...box, helpers, temp, run, toolsCommit };
}

/** File an item, claim it into its own item folder, commit a change there and submit it; returns the item id and its job. */
function submitted(box, title, file) {
  const id = document(fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'The candidate passes.',
    '--check', 'true', '--route', 'strong', '--brief', `Files: ${file}\nTest: the check proves the fixture`, '--wait', '--json')).item.item_id;
  const folder = document(box.run(box.web, 'claim', String(id), '--json')).itemFolder;
  const committed = box.helpers.commitFile(box, folder, file, 'x\n', `feat(web): ${title.toLowerCase()} [G1]`);
  assert.equal(committed.status, 0, `${committed.stderr}${committed.failure ?? ''}`);
  const out = document(box.run(folder, 'submit', String(id), '--no-next', '--json'));
  assert.equal(out.queued, true);
  const job = jobOf(box, id).job;
  const request = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'request.json'), 'utf8'));
  return { id, folder, job, request };
}

test('clause 1: two submits at one tooling commit name one shared tools folder and copy nothing the second time [C7]', async t => {
  const box = await fixture(t);
  const first = submitted(box, 'First shared gate', 'web/first.txt');
  const folders = snapshots(box.temp);
  assert.match(first.request.tools, /pullboard-handoff-tools-[0-9a-f]{40}$/u);
  assert.deepEqual(folders.map(name => join(box.temp, name)), [first.request.tools]);
  const second = submitted(box, 'Second shared gate', 'web/second.txt');
  assert.equal(second.request.tools, first.request.tools, 'both captured requests name the same tools');
  assert.deepEqual(snapshots(box.temp), folders, 'the second submit created no new tools folder');
  assert.equal(readdirSync(box.temp).some(name => name.startsWith('pullboard-handoff-staging-')), false, 'no half copy is left behind');
});

test('clause 2: cleanup of a snapshot while a queued request names it leaves the folder [C7]', async t => {
  const box = await fixture(t);
  const queued = submitted(box, 'Held shared gate', 'web/held.txt');
  const tools = queued.request.tools;
  removeJobToolSnapshot({ job: queued.job.id, tools }, tools);
  removeJobToolSnapshot({ job: 'another-job', tools }, tools);
  assert.equal(existsSync(join(tools, 'apps/cli/src/io/submit/handoff/worker.js')), true, 'the shared snapshot survives a job ending');
  // A private per-job copy is still removed by its own job.
  const own = mkdtempSync(join(tmpdir(), 'pullboard-handoff-tools-job-1-'));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  removeJobToolSnapshot({ job: 'job-1', tools: own }, own);
  assert.equal(existsSync(own), false);
});

test('clause 2: a dead queued worker is relaunched from a shared snapshot [C7]', async t => {
  const box = await fixture(t);
  const queued = submitted(box, 'Recovered shared gate', 'web/recovered.txt');
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', queued.job.id);
  setDriverUnstarted(box.boardFile, queued.job.id, { code: 'TEST_DEAD', message: 'the worker never started' });
  const waiting = () => readdirSync(handoffQueueDirectory()).filter(name => name.includes(queued.job.id)).length;
  const before = waiting();
  const again = box.run(queued.folder, 'submit', String(queued.id), '--no-next');
  assert.equal(again.code, 0, `${again.err}\n${again.out}`);
  assert.match(again.err + again.out, /relaunched queued submit #\d+ from its captured tools/u, `${again.err}\n${again.out}`);
  assert.ok(waiting() > before, 'the dead worker has a fresh launch ticket');
  assert.deepEqual(snapshots(box.temp).map(name => join(box.temp, name)), [queued.request.tools], 'recovery reused the shared snapshot');
});

test('clause 1: the sweep removes unowned tool trees older than 60 minutes and keeps recent or owned ones [C7]', () => {
  const temp = privateFixtureFiles('pullboard-sweep-fixture-');
  const now = Date.now();
  const hoursAgo = hours => new Date(now - hours * 3_600_000);
  for (const name of ['pullboard-handoff-tools-old', 'pullboard-compare-tools-old', 'pullboard-handoff-tools-owned', 'pullboard-handoff-tools-fresh', 'unrelated-old']) {
    temp.write(`${name}/marker`, 'x');
    const age = name.endsWith('fresh') ? hoursAgo(0.1) : hoursAgo(3);
    utimesSync(join(temp.root, name), age, age);
  }
  const removed = sweepToolTrees({ temp: temp.root, now, live: path => path.endsWith('owned') });
  assert.deepEqual(removed.map(path => path.slice(temp.root.length + 1)).sort(), ['pullboard-compare-tools-old', 'pullboard-handoff-tools-old']);
  assert.deepEqual(readdirSync(temp.root).sort(), ['pullboard-handoff-tools-fresh', 'pullboard-handoff-tools-owned', 'unrelated-old']);
});

test('clause 2: a new tool-tree copy is refused under 5 GB free with a refusal naming the sweep [C7]', () => {
  const temp = privateFixtureFiles('pullboard-room-fixture-');
  assert.throws(() => assertToolTreeRoom({ temp: temp.root, minFree: Number.MAX_SAFE_INTEGER }),
    error => error.code === 'TOOL_TREE_DISK_LOW' && /sweep/u.test(error.message));
  assert.doesNotThrow(() => assertToolTreeRoom({ temp: temp.root, minFree: 0 }));
});

test('clause 1: a queued ticket and an unfinished request with no process keep their old tool folder [C7]', () => {
  const temp = privateFixtureFiles('pullboard-queued-fixture-');
  const queue = privateFixtureFiles('pullboard-queue-fixture-');
  const repo = privateFixtureFiles('pullboard-common-fixture-');
  const now = Date.now();
  const old = new Date(now - 3 * 3_600_000);
  const folders = ['queued', 'running', 'finished', 'orphan'].map(name => `pullboard-handoff-tools-${name}`);
  for (const name of folders) { temp.write(`${name}/marker`, 'x'); utimesSync(join(temp.root, name), old, old); }
  queue.write('000000000001-job.json', JSON.stringify({ tools: join(temp.root, folders[0]) }));
  repo.write('pullboard/submit-handoffs/a/request.json', JSON.stringify({ tools: join(temp.root, folders[1]) }));
  repo.write('pullboard/submit-handoffs/b/request.json', JSON.stringify({ tools: join(temp.root, folders[2]) }));
  repo.write('pullboard/submit-handoffs/b/submission.json', '{}');
  assert.ok(queuedToolOwners({ queue: queue.root, commonDirs: [repo.root] }).has(join(temp.root, folders[0])));
  const removed = sweepToolTrees({ temp: temp.root, now, queue: queue.root, commonDirs: [repo.root], live: undefined });
  assert.deepEqual(removed.map(path => path.slice(temp.root.length + 1)).sort(), ['pullboard-handoff-tools-finished', 'pullboard-handoff-tools-orphan']);
  assert.deepEqual(readdirSync(temp.root).sort(), ['pullboard-handoff-tools-queued', 'pullboard-handoff-tools-running']);
});
