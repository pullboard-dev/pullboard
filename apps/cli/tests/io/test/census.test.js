/** A census prints the seconds it spent from start to its first job, through pass 1, and in its reruns [C7,#10525], and per host the minutes its slots sat idle while jobs were queued [C7,#10526]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { pullProject } from '../../fixtures/pull.js';
import { startCensusController } from '../../fixtures/pull.js';
import { openKitBoard } from '../../fixtures/board.js';
import { closeBoard } from '../../../../../packages/board/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';
import { censusPhases } from '../../../src/logic/census.js';
import { censusPhaseLine } from '../../../src/logic/census.js';
import { censusIdleLine } from '../../../src/logic/census.js';
import { censusIdleSlots } from '../../../src/logic/census.js';

const FILES = Array.from({ length: 40 }, (_, index) => `f${String(index).padStart(2, '0')}.test.js`);

/** A private clean repo tracking the 40 fixture files. */
function fixture(t) {
  const box = privateFixtureFiles('pullboard-census-phases-');
  const repo = join(box.root, 'repo'), home = join(box.root, 'machine-home');
  mkdirSync(repo);
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  for (const file of FILES) box.write(`repo/${file}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  return repo;
}

test('cli.io-test-census-phases.a-census-of-40-rows-prints-its-three: clause 1: a census of a recorded 40-row fixture prints the seconds to its first job, through pass 1 and in its reruns, and they add up to its wall clock [C7,#10525]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  let now = 1_000_000;
  // The first shard answers 12 s in; the rest of pass 1 ends at 300 s; the census ends 3 s after.
  const run = async ({ files, write }) => {
    now += 12_000;
    write('# landing shard 1/1 attempt 1 on host-a: green in 9000 ms\n');
    write(`${files.map(file => `# landing-file-ms 1500 ${file}\n# landing-file-exit 0 ${file}`).join('\n')}\n# tests ${files.length}\n# pass ${files.length}\n`);
    now += 288_000;
    write('# landing result: done\n');
    return { isGreen: true };
  };
  const said = [], results = [];
  const io = { err() {}, say: line => said.push(line), result: row => results.push(row) };
  await runCensus(io, { info: { root: repo } }, { out }, { shards: 1, run, clock: () => (now += 3_000 / 2) });
  const phases = results[0].phases;
  assert.equal(phases.firstJobSecs + phases.pass1Secs + phases.rerunSecs, phases.wallSecs);
  assert.ok(Math.abs(phases.wallSecs - results[0].seconds) <= 5);
  assert.ok(phases.firstJobSecs >= 12 && phases.firstJobSecs < 20, `the first job answered after ${phases.firstJobSecs}s`);
  assert.ok(phases.pass1Secs >= 288, `pass 1 took ${phases.pass1Secs}s`);
  assert.ok(said.includes(censusPhaseLine(phases)), 'the summary prints the phase line');
  assert.match(censusPhaseLine(phases), /^census phases: \d+s to the first job, \d+s from the first job to the end of pass 1, \d+s of reruns after it; \d+s in all$/u);
});

test('cli.io-test-census-phases.the-reruns-phase-is-the-time-after-pass: clause 1: the reruns phase is the time from the end of pass 1 to the last rerun, and the three phases add up to the wall clock [C7,#10525]', () => {
  const phases = censusPhases({ start: 0, first: 12_000, pass1: 300_000, end: 360_000 });
  assert.deepEqual(phases, { firstJobSecs: 12, pass1Secs: 288, rerunSecs: 60, wallSecs: 360 });
  assert.deepEqual(censusPhases({ start: 0, first: null, pass1: 5_000, end: 5_000 }), { firstJobSecs: 5, pass1Secs: 0, rerunSecs: 0, wallSecs: 5 }, 'a census whose jobs never answered reads all its time as waiting for the first job');
});

const START = Date.parse('2026-11-17T10:00:00.000Z');
const at = minutes => new Date(START + minutes * 60_000).toISOString();
const job = (host, shard, from, to) => ({ file: `${shard}.test.js`, host, shard, status: 'green', claimedAt: at(from), endedAt: at(to) });

/** A recorded two-host census: host-a ran three jobs at once at its peak, host-b one, and the last first-pass claim came at minute 6. */
const ROWS = [
  job('host-a', '1/4', 0, 6), job('host-a', '1/4', 0, 6), job('host-a', '2/4', 0, 10), job('host-a', '3/4', 4, 14),
  job('host-b', '4/4', 6, 9), job('host-b', '4/4', 6, 9),
  { ...job('host-b', '4/4', 20, 22), outcomes: [] },
  { ...job('none', '5/4', 0, 1) },
];

test('cli.io-test-census-idle-slots.a-recorded-two-host-census-prints-idle: clause 1: a recorded two-host census prints, per host, the minutes its slots sat idle while jobs were still queued [C7,#10526]', () => {
  // The last first-pass claim is at minute 6, so the queued span is 6 minutes.
  const idle = censusIdleSlots(ROWS, START);
  // host-a ran 3 jobs at once at its peak: 18 slot-minutes of span, 6 + 6 + 2 busy inside it, so 4 idle.
  assert.equal(idle['host-a'], 4);
  // host-b has 1 slot and its one job starts at minute 6, after the span: all 6 slot-minutes idle.
  assert.equal(idle['host-b'], 6);
  assert.equal(idle.none, undefined, 'a row that ran on no host is not a host');
  assert.equal(censusIdleLine(idle), 'census idle slot-minutes while jobs were queued: host-a 4, host-b 6');
});

test('cli.io-test-census-idle-slots.a-census-with-no-host-prints-nothing: clause 1: a census whose rows ran on no host prints no idle line [C7,#10526]', () => {
  assert.deepEqual(censusIdleSlots([job('none', '1/1', 0, 1)], START), {});
  assert.equal(censusIdleLine({}), null);
});


test('cli.io-test-census.sigterm-cancels-own-shards: clause 1: SIGTERM withdraws only its unfinished pulled shards and preserves a receipt [C7,#12628]', { timeout: 120_000 }, async t => {
  const box = await pullProject(t, 1);
  for (let i = 0; i < 81; i += 1) writeFileSync(join(box.repo, `census-${i}.test.js`), "import { test } from 'node:test'; test('fixture', () => {});\n");
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, affectedTests: 'node --test' }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: census fixture [C7]');
  const board = openKitBoard(box.boardFile, undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const jobs = () => board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'test' ORDER BY job_created, job_id").all().map(row => row.job_id);
  const wait = async (predicate, description) => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) { const value = predicate(); if (value) return value; await new Promise(resolve => { const watcher = watch(join(box.repo, '.git', 'pullboard'), () => { watcher.close(); resolve(); }); setTimeout(() => { watcher.close(); resolve(); }, 200).unref(); }); }
    assert.fail(`timed out waiting for ${description}`);
  };
  const start = name => {
    const child = startCensusController(box, join(box.dir, `${name}.jsonl`));
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await child.closed; });
    return child;
  };
  const first = start('first');
  const firstIds = await wait(() => { const ids = jobs(); return ids.length >= 3 && ids; }, 'first census offers');
  const second = start('second');
  const secondIds = await wait(() => { const ids = jobs().filter(id => !firstIds.includes(id)); return ids.length >= 3 && ids; }, 'second census offers');
  const call = body => jobQueueCall(board.db, body, { mode: 'pull' });
  const claim = call({ action: 'claim', runner: 'fixture-receipt', capabilities: ['node22'], jobs: [firstIds[0]] }).claim;
  assert.equal(claim?.job, firstIds[0]);
  const receipt = { status: 0, gate: { green: true, phases: [{ status: 0, tail: '' }] } };
  assert.equal(call({ action: 'receipt', runner: 'fixture-receipt', job: claim.job, token: claim.token, receipt }).recorded, true);
  const postedReceipt = jobView(board.db, firstIds[0]).steps.find(step => step.name === 'receipt').payload.receipt;
  first.kill('SIGTERM');
  const ended = await first.closed;
  assert.equal(ended.signal, null, ended.output);
  for (const id of firstIds.slice(1)) assert.equal(jobView(board.db, id).step, 'done');
  assert.deepEqual(jobView(board.db, firstIds[0]).steps.find(step => step.name === 'receipt').payload.receipt, postedReceipt);
  const dispatchable = [];
  for (let i = 0; i < secondIds.length + firstIds.length + 1; i += 1) {
    const claimed = call({ action: 'claim', runner: `fixture-queue-${i}`, capabilities: ['node22'] }).claim;
    if (!claimed) break;
    dispatchable.push(claimed.job);
  }
  assert.deepEqual(dispatchable.sort(), [...secondIds].sort(), 'only the other controller’s jobs remain dispatchable');
  assert.equal(second.exitCode, null, 'the second controller remains alive');
});
