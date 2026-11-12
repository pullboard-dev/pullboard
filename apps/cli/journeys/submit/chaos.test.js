/** Under gate.runnerDispatch pull, killing every process on the submitting host mid-gate leaves the gate finishing on its runner and its receipt recorded on the board [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';

/** The host session's shell: a POSIX sh, never node or the CLI. */
const SHELL = '/bin/sh';

/**
 * The submitting host's processes: every live process whose command line names the project sandbox, plus the extra
 * pids given, leaving out the runner's process trees (whose command lines name the runner's own home) and this test.
 * Why by tree: the runner stands for another machine, and its git fetches name the project's repository too.
 */
function submittingHostPids(box, extra) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const parent = new Map(rows.map(row => [row.pid, row.ppid]));
  const runnerRoots = new Set(rows.filter(row => row.command.includes(box.runnerHome)).map(row => row.pid));
  const inRunner = pid => { for (let at = pid; at > 1; at = parent.get(at) ?? 0) if (runnerRoots.has(at)) return true; return false; };
  return rows.filter(row => (row.command.includes(box.dir) || extra.includes(row.pid)) && row.pid !== process.pid && !inRunner(row.pid)).map(row => row.pid);
}

test('clause 2: killing the submitting host\'s processes mid-gate leaves the gate finishing on its runner and its receipt recorded [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  // The proof holds its job open long enough for the host to be killed while the gate is running.
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': TOOLING['bin/proof.js'].replace('0, 400)', '0, 3000)') } });
  const [id] = box.ids;
  const { folder, commit } = submitOne(box, id);
  // A session stays alive on the submitting host, in the seat's folder, as a dev box's agent would; it names the folder so the sweep finds it.
  // A shell loop, not a node child: the folder is its $0, and the one-second sleeps it leaves when killed end on their own.
  const waiter = spawn(SHELL, ['-c', 'while :; do sleep 1; done', folder], { cwd: folder, env: box.env, stdio: 'ignore' });
  const waiterGone = new Promise(done => waiter.once('exit', (code, signal) => done(signal)));
  t.after(() => { if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGKILL'); });
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });

  const steps = `${box.runnerHome}/r-chaos-steps.jsonl`;
  // Mid-gate: the runner job has recorded its first part and has not finished; each part's write wakes the watch.
  const firstPart = new Promise(done => {
    const seen = () => { if (existsSync(steps) && readFileSync(steps, 'utf8').includes('"step"')) { watcher.close(); done(); } };
    const watcher = watch(box.runnerHome, seen);
  });
  const served = serveOnce(box, url, 'r-chaos');
  await firstPart;
  assert.equal(jobsOf(board.db, { kind: 'gate', item: id })[0].step === 'done', false, 'the gate is still running when the host is killed');
  const killed = submittingHostPids(box, [waiter.pid]);
  assert.ok(killed.includes(waiter.pid), 'the host\'s live session is among the submitting host\'s processes');
  for (const pid of killed) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(await waiterGone, 'SIGKILL');

  const { code, output } = await served;
  assert.equal(code, 0, output);
  assert.deepEqual(submittingHostPids(box, []), [], 'nothing came back on the submitting host');
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  assert.equal(row.step, 'done');
  const receipts = row.steps.filter(step => step.name === 'receipt');
  assert.equal(receipts.length, 1, 'one receipt');
  assert.equal(receipts[0].payload.receipt.gate.green, true, JSON.stringify(receipts[0].payload.receipt.gate).slice(0, 4000));
  const names = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line).step);
  assert.ok(names.includes('proof'), 'the whole gate ran to its proof after the host was killed');
  const item = getItem(board, id);
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', commit], 'the board recorded the receipt as the seat\'s submit');
});
