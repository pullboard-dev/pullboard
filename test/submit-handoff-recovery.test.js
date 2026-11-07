/** Queued gate drivers that die, are stopped or never report keep the gate's record and the builder's claim [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureJoin } from './testkit-fixture.js';
import { driverRecord } from './gate-driver-fixture.js';
import { document, fixture, state, waitJob } from './submit-handoff-fixture.js';

test('a stopped gate driver stops its gate group and retains a native refusal before cleanup [V4,H16,E18,C7]', async t => {
  const box = fixture(t);
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'the captured gate is running', 120000); // budget: observed gate start ceiling, not a timing assertion.
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const owner = driverRecord(box.boardFile, job.id);
  const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(owner.pid)], { encoding: 'utf8' }).trim());
  assert.equal(group, owner.pid, 'the driver the dispatcher started leads the process group that holds its gate');
  process.kill(owner.pid, 'SIGTERM');
  await waitJob(box, 'red');
  assert.equal(state(box, box.id).item.item_status, 'claimed');
  assert.equal(state(box, box.id).job.error.code, 'SUBMIT_HANDOFF_EXIT');
  assert.match(state(box, box.id).job.error.message, /signal SIGTERM/u);
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  await box.helpers.waitFor(() => !existsSync(request.tools) && !existsSync(join(directory, 'source')), // budget: owned driver cleanup ceiling, not a timing assertion.
    'interrupted source and tool snapshot cleanup', 120000);
  assert.equal(existsSync(join(directory, 'worker.json')), false, 'the driver is recorded on the board, never beside the hand-off');
});

for (const mode of ['relaunch', 'missing', 'silent']) test(`a dead queued handoff is ${mode === 'missing' ? 'returned when captured tools are gone' : mode === 'silent' ? 'returned after one silent relaunch' : 'relaunched from captured tools'} [V4,H16,E18]`, async t => {
  const missing = mode === 'missing';
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'initially-silent-tools');
  const exited = join(box.dir, 'initial-worker-exited');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'bin/gate-drive-worker.js');
  writeFileSync(worker, `{
    const fs = await import('node:fs');
    if (process.argv[1]?.endsWith('gate-drive-worker.js') && (${JSON.stringify(mode === 'silent')} || !fs.existsSync(${JSON.stringify(exited)}))) { fs.writeFileSync(${JSON.stringify(exited)}, 'first launch'); process.exit(0); }
  }\n` + readFileSync(worker, 'utf8'));
  const queued = JSON.parse(execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' }));
  assert.equal(queued.queued, true);
  const current = state(box, box.id);
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.job.id);
  await box.helpers.waitFor(() => driverRecord(box.boardFile, current.job.id)?.pid > 0, 'first driver record', 120000); // budget: capped launch ceiling, not a timing assertion.
  const owner = driverRecord(box.boardFile, current.job.id);
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
    await box.helpers.waitFor(() => driverRecord(box.boardFile, current.job.id)?.relaunches === 1 && driverRecord(box.boardFile, current.job.id).pid > 0, 'recovery driver record', 120000); // budget: capped relaunch ceiling, not a timing assertion.
    const relaunched = driverRecord(box.boardFile, current.job.id);
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
