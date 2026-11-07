/** Queued hand-off workers that die, are stopped or never report keep the gate's record and the builder's claim [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import { fixtureJoin } from './testkit-fixture.js';
import { jobView } from '../packages/jobs/index.js';
import { document, fixture, state, waitJob } from './submit-handoff-fixture.js';

test('a worker exiting without a result records its real exit and returns the queued item [V4,H16,E18]', async t => {
  for (const exit of [{ code: 0 }, { code: 7 }, { signal: 'SIGTERM' }]) {
    const box = fixture(t);
    const source = resolve(import.meta.dirname, '..');
    const tools = join(box.dir, 'exiting-tools');
    cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
    const worker = join(tools, 'apps/lib/src/shell/submit-handoff-worker.js');
    const stop = exit.signal ? `process.kill(process.pid, '${exit.signal}')` : `process.exit(${exit.code})`;
    writeFileSync(worker, `if (process.argv[3] === '--execute') { const fs = await import('node:fs'); fs.writeFileSync('untracked-worker-output', 'partial'); fs.writeFileSync('web/snapshot.txt', 'partial'); ${stop}; }\n` + readFileSync(worker, 'utf8'));
    const queued = JSON.parse(execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
      { cwd: box.web, env: box.env, encoding: 'utf8' }));
    assert.equal(queued.queued, true);
    await waitJob(box, 'red');
    const ended = state(box, box.id);
    assert.equal(ended.item.item_status, 'claimed', 'a dead worker returns the claim to its builder, never strands it');
    assert.equal(ended.job.error.code, 'SUBMIT_HANDOFF_EXIT');
    const why = exit.signal ? `code none and signal ${exit.signal}` : `code ${exit.code}`;
    assert.match(ended.job.error.message, new RegExp(`exited with ${why}.*without a terminal result`, 'u'));
    assert.equal(existsSync(box.started), false, 'no candidate gate was manufactured');
    const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', ended.job.id);
    const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
    const failure = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
    assert.deepEqual(failure.error, ended.job.error, 'the private refusal and native result retain the same cause');
    await box.helpers.waitFor(() => !existsSync(request.tools), 'failed worker snapshot cleanup', 120000); // budget: existing owned-child cleanup ceiling, not a performance assertion.
  }
});

test('supervisor termination reaches its live child and retains a native refusal before cleanup [V4,H16,E18]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'interrupted-tools');
  const ready = join(box.dir, 'live-child.json');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/lib/src/shell/submit-handoff-worker.js');
  writeFileSync(worker, `if (process.argv[3] === '--execute') {
    const fs = await import('node:fs');
    fs.writeFileSync('untracked-worker-output', 'partial');
    const group = Number((await import('node:child_process')).execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid, group}));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }\n` + readFileSync(worker, 'utf8'));
  const queued = JSON.parse(execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' }));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(ready), 'actual supervised child readiness', 120000); // budget: owned child readiness ceiling, not a timing assertion.
  const child = JSON.parse(readFileSync(ready, 'utf8'));
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const owner = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  assert.equal(child.group, owner.pid, 'signal only the actual launcher-owned supervisor, whose process group holds the gate');
  process.kill(owner.pid, 'SIGTERM');
  await waitJob(box, 'red');
  assert.equal(state(box, box.id).item.item_status, 'claimed');
  assert.equal(state(box, box.id).job.error.code, 'SUBMIT_HANDOFF_EXIT');
  assert.match(state(box, box.id).job.error.message, /signal SIGTERM/u);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'the owned child has actually closed');
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  await box.helpers.waitFor(() => !existsSync(request.tools) && !existsSync(join(directory, 'source')), // budget: owned child cleanup ceiling, not a timing assertion.
    'interrupted dirty source and tool snapshot cleanup', 120000);
  assert.equal(existsSync(join(tools, 'bin/pullboard.js')), true, 'cleanup preserves the builder installation');
});

for (const mode of ['relaunch', 'missing', 'silent']) test(`a dead queued handoff is ${mode === 'missing' ? 'returned when captured tools are gone' : mode === 'silent' ? 'returned after one silent relaunch' : 'relaunched from captured tools'} [V4,H16,E18]`, async t => {
  const missing = mode === 'missing';
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'initially-silent-tools');
  const exited = join(box.dir, 'initial-worker-exited');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/lib/src/shell/submit-handoff-worker.js');
  writeFileSync(worker, `{
    const fs = await import('node:fs');
    if (process.argv[1]?.endsWith('submit-handoff-worker.js') && (${JSON.stringify(mode === 'silent')} || !fs.existsSync(${JSON.stringify(exited)}))) { fs.writeFileSync(${JSON.stringify(exited)}, 'first launch'); process.exit(0); }
  }\n` + readFileSync(worker, 'utf8'));
  const queued = JSON.parse(execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' }));
  assert.equal(queued.queued, true);
  const current = state(box, box.id);
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.job.id);
  await box.helpers.waitFor(() => existsSync(join(directory, 'worker.json')), 'first worker record', 120000); // budget: capped launch ceiling, not a timing assertion.
  const owner = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  await box.helpers.waitFor(() => { // budget: owned process exit ceiling, not a timing assertion.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'actual first worker exit', 120000);
  assert.equal(state(box, box.id).job.state, 'queued', 'the first worker actually exited before any result');
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  if (missing) rmSync(request.tools, { recursive: true, force: true });
  else writeFileSync(box.release, 'release\n');
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  const contenders = [0, 1].map(() => box.helpers.launch(box, box.web, process.execPath, [box.helpers.BIN, 'next', '--json']));
  for (const contender of contenders) { const exit = await contender.closed; assert.equal(exit.code, 0, contender.stderrText); }
  if (mode === 'silent') {
    await box.helpers.waitFor(() => JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')).relaunches === 1, 'recovery worker record', 120000); // budget: capped relaunch ceiling, not a timing assertion.
    const relaunched = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
    assert.equal(relaunched.relaunches, 1);
    await box.helpers.waitFor(() => { // budget: owned recovery process exit ceiling, not a timing assertion.
      try { process.kill(relaunched.pid, 0); return false; }
      catch (error) { return error.code === 'ESRCH'; }
    }, 'actual recovery worker exit', 120000);
    document(box.run(box.web, 'next', '--json'));
  }
  await waitJob(box, mode === 'relaunch' ? 'green' : 'infrastructure');
  const ended = state(box, box.id);
  assert.equal(ended.job.id, current.job.id, 'recovery retains the original immutable queue');
  if (mode !== 'relaunch') {
    assert.equal(ended.item.item_status, 'claimed');
    assert.equal(ended.job.error.code, 'SUBMIT_HANDOFF_DEAD');
    assert.match(ended.job.error.message, /dead and cannot be relaunched/u);
    assert.equal(existsSync(box.started), false, 'failure recovery invents no gate or proof');
    const other = join(box.dir, 'other-web');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
    document(fixtureJoin(box.run, other, 'web', '--route', 'strong', '--json'));
    const foreign = box.run(other, 'claim', String(box.id), '--json');
    assert.equal(JSON.parse(foreign.out).error.code, 'HELD');
    if (mode === 'silent') rmSync(request.tools, { recursive: true, force: true });
  } else {
    assert.equal(ended.item.item_status, 'submitted');
    assert.equal(ended.item.item_commit, box.commit);
    assert.equal(readFileSync(join(box.dir, 'started.jsonl'), 'utf8').trim().split('\n').length, 1, 'concurrent recovery runs exactly one real gate');
  }
});

test('clause 1: the real hand-off worker is a drive worker child; killing it mid-gate loses nothing and the next driver finishes [C7]', async t => {
  const box = fixture(t);
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'captured gate begins', 120000); // budget: observed worker progress ceiling, not a timing assertion.
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const drive = JSON.parse(readFileSync(join(directory, 'drive.json'), 'utf8'));
  assert.equal(drive.start, 0);
  const supervisor = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(drive.pid)], { encoding: 'utf8' }).trim());
  assert.equal(parent, supervisor.pid, 'the hand-off worker the dispatcher started runs the drive worker as its child');
  process.kill(drive.pid, 'SIGKILL');
  await box.helpers.waitFor(() => JSON.parse(readFileSync(join(directory, 'drive.json'), 'utf8')).start === 1, 'next drive worker', 120000); // budget: observed respawn ceiling, not a timing assertion.
  assert.equal(state(box, box.id).job.state, 'running', 'the killed worker ended nothing');
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  /** The drive job's persisted steps, read from the real board file. */
  const driveSteps = () => {
    // @pullboard-board-file journey: read the drive job's persisted steps after both workers.
    const board = openBoard(box.boardFile);
    try { return jobView(board.db, drive.job).steps; } finally { board.db.close(); }
  };
  // The gate's own board moves land first; the drive worker writes collected and verdict on its next poll.
  await box.helpers.waitFor(() => driveSteps().some(step => step.name === 'verdict'), 'drive job verdict', 120000); // budget: observed drive poll ceiling, not a timing assertion.
  const steps = driveSteps();
  const named = name => steps.filter(step => step.name === name).length;
  assert.deepEqual([named('captured'), named('running'), named('collected'), named('verdict')], [1, 1, 1, 1], 'the next driver continued the same job to its verdict');
  assert.equal(readFileSync(box.started, 'utf8').trim().split('\n').length, 1, 'the gate ran once: the death lost nothing and the resume reran nothing');
  assert.equal(readFileSync(box.finished, 'utf8').trim().split('\n').length, 1);
});
