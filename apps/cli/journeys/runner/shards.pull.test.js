/** A pulled gate whose proof selects more files than one runner's cores offers it as shard jobs any runner pulls; one combined result applies when the last shard posts [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { SHARD_JOB_KIND } from '../../../../packages/api/index.js';
import { keptOutputFolder } from '../../../../packages/drive/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { TOOLING } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/**
 * Main's stand-in tooling with a proof of one file more than this host's cores, run by a named-file runner that notes
 * the files it was handed; a file named `red` makes its run fail. The runners are processes on this host, so their
 * cores are the planner's.
 */
function shardTooling(red = null, redOutput = '') {
  return {
    'packages/gate/index.js': `${TOOLING['packages/gate/index.js'].replace(/export function submitGatePlan[\s\S]*?\n\}\n/u, '')}import { availableParallelism } from 'node:os';
export function submitGatePlan(root, config, options) {
  record(root, 'selection');
  const files = Array.from({ length: availableParallelism() + 1 }, (_, n) => 'web/p' + n + '.test.js');
  return { check: options.check, selection: { full: false, reason: 'fixture', files }, proofFiles: files, testRunner: 'node bin/proof.js',
    proofCommand: 'node bin/proof.js ' + files.map(file => "'./" + file + "'").join(' ') };
}
`,
    'bin/proof.js': `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'proof', files: process.argv.slice(2) }) + '\\n');
if (${JSON.stringify(red)} && process.argv.includes(${JSON.stringify(red)})) { process.stdout.write(${JSON.stringify(redOutput)}); process.exit(1); }
`,
  };
}

/** The files each proof run on one runner was handed, from the steps it noted. */
function proofFiles(box, runner) {
  const steps = join(box.runnerHome, `${runner}-steps.jsonl`);
  if (!existsSync(steps)) return [];
  return readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(step => step.step === 'proof').flatMap(step => step.files);
}

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

/** Submit one item, serve its gate job on one runner, and return the board with the shard jobs the gate's receipt offered. */
async function shardedGate(t, red, redOutput = '') {
  const box = await pullProject(t, 1, { tooling: shardTooling(red, redOutput) });
  const [id] = box.ids;
  const submitted = submitOne(box, id);
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const served = await serveOnce(box, queue.url, 'r-gate');
  assert.equal(served.code, 0, served.output);
  return { box, id, submitted, ...queue };
}

test('clause 1: a pulled gate whose proof selects more files than one runner\'s cores is offered as shard jobs, and two runners pulling them each run a disjoint part [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, one submit, a gate and two shards in runner processes.
async t => {
  const { box, id, submitted, board, url } = await shardedGate(t, null);
  const [gate] = jobsOf(board.db, { kind: 'gate', item: id });
  const planned = gate.steps.find(step => step.name === 'receipt').payload.receipt.gate;
  assert.equal(planned.green, false, 'a gate that left its proof to shards is not green on its own');
  const files = planned.proofPlan.files;
  assert.ok(files.length > planned.proofPlan.cores, JSON.stringify(planned.proofPlan));
  assert.deepEqual(proofFiles(box, 'r-gate'), [], 'the gate\'s own runner ran no part of the proof');
  const shards = jobsOf(board.db, { kind: SHARD_JOB_KIND, item: id });
  assert.equal(shards.length, 2, 'one shard per runner\'s worth of cores');
  assert.deepEqual(shards.map(row => [row.step, row.candidate]), [['offered', submitted.commit], ['offered', submitted.commit]]);

  for (const runner of ['r-one', 'r-two']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  const one = proofFiles(box, 'r-one'), two = proofFiles(box, 'r-two');
  assert.ok(one.length > 0 && two.length > 0, 'each runner ran a part');
  assert.deepEqual(one.filter(file => two.includes(file)), [], 'the parts are disjoint');
  assert.deepEqual([...one, ...two].sort(), files.map(file => './' + file).sort(), 'together they are the whole proof');
  const runners = jobsOf(board.db, { kind: SHARD_JOB_KIND, item: id }).map(row => row.steps.find(step => step.name === 'receipt').payload.runner);
  assert.deepEqual(runners, ['r-one', 'r-two']);
  const item = getItem(board, id);
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', submitted.commit], `${facts(board, id)}`);
});

test('clause 2: the gate result is recorded only after every shard posts, and is red when any shard is red [P7]', { timeout: 240_000 }, // budget: as clause 1.
async t => {
  const { box, id, board, url } = await shardedGate(t, './web/p0.test.js');
  const before = getItem(board, id);
  assert.equal((await serveOnce(box, url, 'r-red')).code, 0);
  assert.ok(proofFiles(box, 'r-red').includes('./web/p0.test.js'), 'the first shard holds the red file');
  const midway = getItem(board, id);
  assert.deepEqual([midway.item_status, midway.item_owner], ['claimed', before.item_owner], 'one red shard posted: the item is unchanged');
  assert.doesNotMatch(facts(board, id), /failing parts|submitted for review/u, 'and no gate result is recorded yet');

  assert.equal((await serveOnce(box, url, 'r-green')).code, 0);
  const shards = jobsOf(board.db, { kind: SHARD_JOB_KIND, item: id });
  assert.deepEqual(shards.map(row => row.steps.find(step => step.name === 'receipt').payload.receipt.gate.green), [false, true]);
  const after = getItem(board, id);
  assert.deepEqual([after.item_status, after.item_owner], ['claimed', before.item_owner], 'red: the item stays with its builder');
  assert.match(facts(board, id), /red at [0-9a-f]{12}; failing parts:\n(?:.*\n)*proof exited 1/u, 'the combined result is red, recorded once the last shard posted');
});

/** A red shard's TAP: two failing cases, then enough passing subtests that its tail and exit lines show only passes. */
const RED_TAP = ['TAP version 13',
  'not ok 1 - merges a stale base', '  ---', '  duration_ms: 1', "  location: './web/p0.test.js:3:1'", "  failureType: 'testCodeFailure'", "  error: 'stale base'", '  ...',
  'not ok 2 - keeps the guard', '  ---', '  duration_ms: 1', "  location: './web/p0.test.js:9:1'", "  failureType: 'testCodeFailure'", "  error: 'guard lost'", '  ...',
  ...Array.from({ length: 300 }, (_, n) => `ok ${n + 3} - passing subtest ${n}`), '1..302', '# fail 2', ''].join('\n');

test('a red pulled proof shard\'s fact lists each not ok file and case and its log path ahead of the tail [C7]', { timeout: 240_000 }, // budget: as clause 1 of the shard journey.
async t => {
  const { box, id, board, url } = await shardedGate(t, './web/p0.test.js', RED_TAP);
  for (const runner of ['r-red', 'r-green']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  const [red] = jobsOf(board.db, { kind: SHARD_JOB_KIND, item: id });
  const proof = red.steps.find(step => step.name === 'receipt').payload.receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.doesNotMatch(`${proof.tail}\n${proof.exit}`.slice(-600), /not ok/u, 'the shard\'s tail shows only passing subtests');
  const fact = facts(board, id).split('Gate job ').find(text => /failing parts/u.test(text)) ?? '';
  const log = join(keptOutputFolder(join(box.runnerHome, 'r-red'), red.id, 1), 'proof.log');
  const lines = fact.split('\n');
  const at = pattern => lines.findIndex(line => pattern.test(line));
  const first = at(/^proof not ok: web\/p0\.test\.js :: merges a stale base \(shard \S+:shard:1\)$/u);
  const second = at(/^proof not ok: web\/p0\.test\.js :: keeps the guard \(shard \S+:shard:1\)$/u);
  const kept = lines.indexOf(`proof shard ${red.id} log: ${log} on runner r-red`);
  const tail = at(/^proof exited 1: /u);
  assert.ok(first > 0 && second > first && kept > second && tail > kept, fact);
  assert.match(readFileSync(log, 'utf8'), /^not ok 2 - keeps the guard$/mu, 'the named log holds the shard\'s full output');
});

/** A red shard's TAP with `count` failing cases, then passing subtests that fill its tail. */
function manyRedTap(count) {
  const failing = Array.from({ length: count }, (_, n) => [`not ok ${n + 1} - case number ${n}`, '  ---', '  duration_ms: 1', `  location: './web/p0.test.js:${n + 1}:1'`,
    "  failureType: 'testCodeFailure'", "  error: 'x'", '  ...']).flat();
  return ['TAP version 13', ...failing, ...Array.from({ length: 300 }, (_, n) => `ok ${count + n + 1} - passing subtest ${n}`), `1..${count + 300}`, `# fail ${count}`, ''].join('\n');
}

test('a red pulled proof shard with more than 50 not ok cases still names every one in the fact [C7]', { timeout: 240_000 }, // budget: as clause 1 of the shard journey.
async t => {
  const count = 60;
  const { box, id, board, url } = await shardedGate(t, './web/p0.test.js', manyRedTap(count));
  for (const runner of ['r-red', 'r-green']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  const fact = facts(board, id).split('Gate job ').find(text => /failing parts/u.test(text)) ?? '';
  const named = fact.split('\n').filter(line => /^proof not ok: web\/p0\.test\.js :: case number \d+ \(shard /u.test(line));
  assert.equal(named.length, count, 'every not ok case is named, none cut to a cap');
  assert.doesNotMatch(fact, /more in shard/u, 'no case is left to the log');
});
