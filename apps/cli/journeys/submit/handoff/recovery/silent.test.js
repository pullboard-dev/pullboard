/** A dead queued handoff that stays silent is returned after one relaunch [V4,H16,E18] */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { fixtureJoin } from '../../../../tests/fixtures/testkit.js';
import { driverRecord } from '../../../../tests/fixtures/gate/driver.js';
import {
  document,
  fixture,
  state,
  waitJob,
} from '../../../../tests/fixtures/submit/handoff.js';

/**
 * Copy the parts of the repository a captured-tools driver runs from: both source trees and the package manifest.
 * Why: the docs, skills and release files are never read by a driver, and copying them per case dominated the copy.
 */
function copyTools(source, tools) {
  for (const entry of ['apps', 'packages', 'package.json']) cpSync(join(source, entry), join(tools, entry), { recursive: true });
}

for (const mode of ['silent']) test(`a dead queued handoff is ${mode === 'missing' ? 'returned when captured tools are gone' : mode === 'silent' ? 'returned after one silent relaunch' : 'relaunched from captured tools'} [V4,H16,E18]`, async t => {
  const missing = mode === 'missing';
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '../../../../../..');
  const tools = join(box.dir, 'initially-silent-tools');
  const exited = join(box.dir, 'initial-worker-exited');
  copyTools(source, tools);
  const worker = join(tools, 'apps/cli/src/io/gate/drive.js');
  // The driver entry starts with a shebang, which must stay its first line; the fixture's exit goes right after it.
  const [shebang, ...body] = readFileSync(worker, 'utf8').split('\n');
  writeFileSync(worker, `${shebang}\n{
    const fs = await import('node:fs');
    if (process.argv[1]?.endsWith('gate-drive-worker.js') && (${JSON.stringify(mode === 'silent')} || !fs.existsSync(${JSON.stringify(exited)}))) { fs.writeFileSync(${JSON.stringify(exited)}, 'first launch'); process.exit(0); }
  }\n` + body.join('\n'));
  const queued = JSON.parse(execFileSync(process.execPath, [join(tools, 'apps/cli/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
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
