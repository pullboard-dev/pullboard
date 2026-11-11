/** Queued handoff results, source preparation and unrelated-main merges keep the captured proof [V4,H16,E18,C7,A5]. */
import { submitHandoffEventContract } from '../../../tests/fixtures/generated/handoff.js';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { openBoard } from '../../../../lib/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { completeSubmitHandoff } from '../../../../../packages/store/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import {
  document,
  fixture,
  removeSandboxes,
  state,
  waitJob,
  word,
  workerDiagnostic,
  workerGone,
  helpersCommit,
} from '../../../tests/fixtures/submit/handoff.js';

test('setting off retains foreground submit until the real gate finishes [V4]', async t => {
  const box = fixture(t, { enabled: false });
  const child = box.helpers.launch(box, box.web, process.execPath, [box.helpers.BIN, 'submit', String(box.id), '--no-next', '--json']);
  let closed = false;
  child.closed.then(() => { closed = true; });
  await box.helpers.waitFor(() => existsSync(box.started), 'foreground gate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  assert.equal(closed, false);
  assert.equal(state(box, box.id).job, null);
  writeFileSync(box.release, 'release\n');
  const exit = await child.closed;
  assert.equal(exit.code, 0, child.stderrText);
  assert.equal(JSON.parse(child.stdoutText).gate.green, true);
});

test('a handoff result cannot invent a green submission or complete another sender job [V4,E18]', async t => {
  const box = fixture(t);
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  // @pullboard-board-file journey: observe the separate native worker's actual persisted queue and proof identity.
  const board = openBoard(box.boardFile);
  try {
    const job = submitHandoff(board, box.id);
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: 'foreign-seat', job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_CHANGED' });
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: job.agentId, job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_RESULT' });
    assert.equal(getItem(board, box.id).item_status, 'claimed');
  } finally { board.db.close(); }
});

/** Install a real checkout barrier while preserving and invoking any existing native hook byte-for-byte. */
function checkoutBarrier(box) {
  const ready = join(box.dir, 'private-checkout-ready');
  const release = join(box.dir, 'private-checkout-release');
  box.releases.push(release);
  const script = join(box.dir, 'checkout-barrier.cjs');
  writeFileSync(script, [
    "const fs=require('node:fs'); const cwd=process.cwd();",
    `if(cwd.includes('/submit-handoffs/') && cwd.endsWith('/source') && !fs.existsSync(${JSON.stringify(ready)})) {`,
    ` fs.writeFileSync(${JSON.stringify(ready)},cwd); const deadline=Date.now()+120000;`,
    ` while(!fs.existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) throw Error('checkout release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  const hooks = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  // Use an absolute spelling of the same active native directory, so linked worktrees share the barrier; all existing guards stay intact.
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'post-checkout');
  let original = '';
  if (existsSync(hook)) {
    const copy = join(hooks, 'post-checkout.native');
    writeFileSync(copy, readFileSync(hook));
    chmodSync(copy, 0o755);
    original = `${word(copy)} "$@" || exit "$?"\n`;
  }
  writeFileSync(hook, `#!/bin/sh\n${original}exec ${word(process.execPath)} ${word(script)} "$@"\n`);
  chmodSync(hook, 0o755);
  return { ready, release };
}

test('removing the builder checkout during private source preparation cannot move or strand the queued gate [V4,H16,E18]', async t => {
  const box = fixture(t);
  const barrier = checkoutBarrier(box);
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  await box.helpers.waitFor(() => existsSync(barrier.ready), 'actual private checkout hook', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  box.git(box.web, 'checkout', '-q', '--detach', 'main');
  assert.equal(helpersCommit(box, 'web/another-build.txt', 'independent\n').status, 0);
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  box.git(box.repo, 'worktree', 'remove', box.web);
  assert.equal(existsSync(box.web), false);
  writeFileSync(barrier.release, 'release\n');
  await box.helpers.waitFor(() => existsSync(box.started), 'captured gate after removal of original checkout', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  assert.deepEqual(readFileSync(box.finished, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: box.commit }]);
});

/** Build a bounded real test selection, so an unrelated accepted-main move may use the ordinary merge path. */
function mainAdvanceFixture(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const release = join(box.dir, 'advance-release');
  const started = join(box.dir, 'advance-started');
  const armed = join(box.dir, 'advance-armed');
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature = 'base';\n");
  writeFileSync(join(box.repo, 'web/other.js'), "export const other = 'independent';\n");
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('independent feature [G1]',()=>assert.equal(other,'independent'));\n");
  mkdirSync(join(box.repo, 'apps/cli/src/io/run'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), [
    "import {spawnSync} from 'node:child_process';",
    "const env={...process.env};delete env.NODE_TEST_CONTEXT;",
    "const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});",
    "process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;",
  ].join('\n'));
  writeFileSync(join(box.repo, 'test/feature.test.js'), [
    "import assert from 'node:assert/strict';import {test} from 'node:test';import fs from 'node:fs';",
    "import {feature} from '../web/feature.js';",
    "test('captured feature [G1]',()=>{assert.equal(feature,'item');",
    `if(fs.existsSync(${JSON.stringify(armed)})){fs.writeFileSync(${JSON.stringify(started)},'started');const deadline=Date.now()+120000;`,
    `while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('release never arrived');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}});`,
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // The web lane owns the runner and the test, so claiming the item is not a cross-ownership refusal [C7,#2650].
  const lanes = { ...config.lanes, web: { ...config.lanes.web, owns: [...config.lanes.web.owns, 'apps/cli/src/io/run/', 'test/'] } };
  writeFileSync(configFile, JSON.stringify({ ...config, lanes, gate: 'node apps/cli/src/io/run/tests.js test/feature.test.js',
    affectedTests: 'node apps/cli/src/io/run/tests.js', submit: { handoff: true } }) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: bounded native moving-main fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Queued proof across accepted main', '--specs', 'G1',
    '--criterion', 'The captured feature is item.', '--check', 'node apps/cli/src/io/run/tests.js test/feature.test.js', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', "export const feature = 'item';\n", 'feat(web): captured implementation [G1]').status, 0);
  document(box.run(box.repo, 'bar', 'ready', 'on', '--json'));
  writeFileSync(armed, 'armed\n');
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => {
      const job = state(box, id).job;
      return !job || !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
    }, `moving-main worker cleanup: ${workerDiagnostic(box, id)}`);
    const job = state(box, id).job;
    if (job) await workerGone(helpers, box, job.id);
    await removeSandboxes(helpers);
  });
  return { ...box, id, helpers, release, started };
}

test('clause 1: queued submit keeps the ordinary hook-checked unrelated-main merge after captured proof [V4,H16,C7]', async t => {
  const box = mainAdvanceFixture(t);
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  try { await box.helpers.waitFor(() => existsSync(box.started), 'real captured feature gate', 120000); } // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  catch (error) { throw new Error(`${error.message}\n${workerDiagnostic(box, box.id)}`, { cause: error }); }
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs/unrelated.md'), 'accepted unrelated main content\n');
  box.git(box.repo, 'add', 'docs/unrelated.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: unrelated accepted main [G1]');
  const accepted = box.git(box.repo, 'rev-parse', 'HEAD');
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  const completed = state(box, box.id);
  // 12482431d6 (#2366) defers composing later main to landing, so no merge hook runs and the proof keeps its captured source.
  assert.equal(completed.job.hookProjection, undefined, 'no merge hook ran inside the queued submit');
  assert.equal(completed.item.item_commit, queued.commit, 'the queued proof records its captured source; landing composes later main');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), accepted, 'the unrelated accepted main commit stays on main');
});


test('the handoff documentation receives actual detached-worker event kinds and fields [A5,V4,H16]', async t => {
  const rows = await submitHandoffEventContract(t);
  const queued = rows.filter(row => row.event_kind === 'submit-handoff');
  assert.ok(queued.some(row => row.detail.state === 'queued'));
  assert.ok(queued.some(row => row.detail.state === 'red'));
  // db3dba1506 reopens rejected and returned work to every eligible seat at once, so no first-refusal window is sealed.
  assert.equal(rows.find(row => row.event_kind === 'submit_handoff_returned').detail.reopenFirstRefusal, undefined);
});
