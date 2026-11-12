/** Physical runner timing, bounded cache work and measured capacity warnings [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  validateCacheTips,
} from '../../../../packages/runners/index.js';
import { startRunnerPhases } from '../../../../packages/gate/index.js';
import { runnerPhaseFields } from '../../../../packages/gate/index.js';
import { runnerPhaseLine } from '../../../../packages/gate/index.js';
import { doctrineExecutionPhases } from '../../index.js';
import { runnerUtilization } from '../../../../packages/runners/index.js';
import {
  receiptLine,
  recordReceipt,
} from '../../../../packages/gate/index.js';
import { localRunnerDescriptor } from '../../../../packages/runners/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('per-check worker phases conserve time and print separately from controller phases [C7]', async () => {
  let now = 0;
  const tracker = startRunnerPhases(() => now);
  for (const [at, name] of [[5, 'capacityWaitMs'], [20, 'sourceMs'], [45, 'dependenciesMs'], [55, 'commandMs'], [120, 'cleanupMs']]) {
    now = at;
    tracker.mark(name);
  }
  now = 130;
  const phases = tracker.finish();
  assert.deepEqual(phases, { version: 1, prepareMs: 5, capacityWaitMs: 15, sourceMs: 25,
    dependenciesMs: 10, commandMs: 65, cleanupMs: 10, totalMs: 130 });
  assert.deepEqual(tracker.finish(), phases);
  assert.equal(runnerPhaseFields({ ...phases, totalMs: 129 }), null);
  assert.equal(runnerPhaseFields(undefined), null, 'older workers do not gain invented measurements');
  const line = receiptLine({ waitMs: 10, admissionMs: 5, setupMs: 2, runMs: 150, evidenceMs: 3,
    slot: { kind: 'runner', reason: 'fixture' }, executionPhases: phases });
  assert.match(line, /run 0\.15s.*executor: prepare 0\.01s.*command 0\.07s.*total 0\.13s/u);
  assert.equal(runnerPhaseLine({ ...phases, commandMs: -1 }), '');
});

test('batched tip inventory retains exact object order and refuses missing or non-commit objects [C7]', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.doesNotThrow(() => validateCacheTips([a, b], `${a} commit 123\n${b} commit 456\n`));
  assert.doesNotThrow(() => validateCacheTips([], ''));
  for (const output of [`${a} missing\n${b} commit 456`, `${a} tree 123\n${b} commit 456`,
    `${b} commit 456\n${a} commit 123`, `${a} commit 123`, `${a} commit 123\n${b} commit 456\n\n`]) {
    assert.throws(() => validateCacheTips([a, b], output));
  }
});

/** One actual slot interval on a reported two-slot runner. */
function interval(runner, start, end, occupiedSlots = 1) {
  return { at: new Date(end).toISOString(), admittedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString(),
    runner, occupiedSlots, inherited: false, timing: false, waitMs: 0, runMs: end - start, slot: { kind: 'runner' } };
}

test('five-minute peak over 70 percent warns with observed capacity and incomplete evidence stays unknown [C7]', async () => {
  const runner = { ...localRunnerDescriptor(2, true), active: 0 };
  const end = Date.parse('2026-10-27T12:00:00Z');
  const window = { from: new Date(end - 300_000).toISOString(), to: new Date(end).toISOString() };
  const receipt = interval(runner, end - 240_000, end, 2);
  const observed = runnerUtilization([runner], [receipt], window);
  assert.equal(observed.runners[0].peakBusyShare, 0.8);
  assert.equal(observed.runners[0].slotsForTarget, 3);
  assert.match(observed.warnings[0], /80\.0% exceeds 70%.*retained board runs only.*capacity unchanged/u);
  assert.equal(runnerUtilization([runner], [interval(runner, end - 210_000, end, 2)], window).warnings.length, 0, 'exactly70% is not above target');
  for (const receipts of [[], [{ ...receipt, runner: { ...runner, slots: { current: 3, limit: 3, elastic: false } } }],
    [{ ...receipt, timing: true }], [{ ...receipt, admittedAt: null }], [{ ...receipt, inherited: true }]]) {
    const result = runnerUtilization([runner], receipts, window);
    assert.equal(result.runners[0].peakBusyShare, null, JSON.stringify(receipts));
    assert.equal(result.warnings.length, 0);
  }
});

test('status exposes the measured over-70-percent warning from real Git and SQLite state [C7]', async () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const end = Date.now() - 1000;
  recordReceipt(box.repo, interval({ ...localRunnerDescriptor(2, true), active: 0 }, end - 240_000, end, 2));
  const output = await box.runLocal(box.repo, 'status', '--json');
  assert.equal(output.code, 0, output.err);
  const result = JSON.parse(output.out);
  assert.equal(result.runnerUtilization.available, true);
  assert.match(result.runnerUtilization.warnings.join('\n'), /observed peak utilization .* exceeds 70%/u);
});

test('the real runner emits phase receipts and validates many retained tips in one Git batch [C7]', async () => {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'source');
  const remoteHome = join(box.dir, 'remote-home');
  const remoteMachine = join(remoteHome, 'machine');
  const worker = join(box.dir, 'worker');
  const bin = join(box.dir, 'ssh-bin');
  for (const directory of [repo, remoteHome, remoteMachine, worker, bin]) mkdirSync(directory, { recursive: true });
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), '{"gate":"true"}\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-qm', 'chore: runner fixture');
  const head = box.git(repo, 'rev-parse', 'HEAD').trim();
  const calls = join(box.dir, 'git-calls.jsonl');
  const preload = join(box.dir, 'capture.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';
const original=cp.spawn;cp.spawn=(command,args,options)=>{if(command==='git'&&args[0]==='cat-file')appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');return original(command,args,options);};syncBuiltinESMExports();`);
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachine, requests: join(box.dir, 'requests'),
    nodeOptions: `--import=${new URL('file://' + preload).href}` });
  const source = `import {runOnRunnerAsync} from ${JSON.stringify(new URL('../../../../packages/runners/index.js', import.meta.url).href)};
const result=await runOnRunnerAsync(process.cwd(),'node -e "console.log(42)"',{runner:{host:${JSON.stringify(HOST)},slots:1,browser:1}});
console.log(JSON.stringify({green:result.isGreen,phases:result.executionPhases,output:result.output}));`;
  /** One cold execution prepares the cache; the second proves the distinct warm-cache path. */
  async function execute() {
    const ran = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repo, env: { ...box.env, PATH: `${bin}:${box.env.PATH}` }, encoding: 'utf8',
    });
    assert.equal(ran.status, 0, `${ran.context}\n${ran.stdout}`);
    const result = JSON.parse(ran.stdout.trim().split('\n').at(-1));
    assert.equal(result.green, true, result.output);
    assert.ok(runnerPhaseFields(result.phases), JSON.stringify(result));
    assert.ok(result.phases.commandMs > 0);
    return result;
  }
  await execute();
  const id = createHash('sha256').update(box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()).digest('hex');
  const cache = join(remoteHome, '.pullboard-runner', 'repos', `${id}.git`);
  for (let index = 0; index < 20; index += 1) box.git(cache, 'update-ref', `refs/pullboard/candidates/fixture-${index}/${head}`, head);
  writeFileSync(calls, '');
  await execute();
  const inventory = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(inventory.filter(args => args.includes('--batch-check')).length, 2, 'retained cache tips and the received candidate each take one bounded validation batch');
  assert.ok(inventory.filter(args => args[1] === '-t').length < 10, 'there is no per-retained-ref type-check loop');
});
test('doctrine phases sum complete sequential observations and reject gaps [C7]', async () => {
  const phase = { version: 1, prepareMs: 1, capacityWaitMs: 2, sourceMs: 3, dependenciesMs: 4, commandMs: 5, cleanupMs: 6, totalMs: 21 };
  assert.deepEqual(doctrineExecutionPhases([{ executionPhases: phase }, { executionPhases: phase }], 2),
    { version: 1, prepareMs: 2, capacityWaitMs: 4, sourceMs: 6, dependenciesMs: 8, commandMs: 10, cleanupMs: 12, totalMs: 42 });
  assert.equal(doctrineExecutionPhases([{ executionPhases: phase }], 2), null);
  assert.equal(doctrineExecutionPhases([{ executionPhases: { ...phase, totalMs: 0 } }], 1), null);
  assert.equal(doctrineExecutionPhases([], 0), null);
});
