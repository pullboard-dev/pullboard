/** The pulled-submit main-move fixture: a claimed candidate whose gate holds while main moves, then settles [V4,H16,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from '../e2e.js';
import { FIXTURE_MODEL } from '../child.js';
import { runFixtureChild } from '../child.js';
import { fixtureAdd } from '../testkit.js';
import { fixtureProjectPolicy } from '../testkit.js';
import { settleSubmit } from './settle.js';
import { removeSandboxes } from './handoff.js';

/** Read the fixture item's durable status, submitted commit and verdict without writing the board. */
export function item(box) {
  // @pullboard-board-file journey: the real CLI owns every queue, submission and verdict write.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return db.prepare('SELECT item_status,item_commit,item_verdict FROM item WHERE item_id=?').get(box.id);
  } finally { db.close(); }
}

/**
 * Build a claimed candidate whose frozen check holds at a release file while the gate runs, then move main once the
 * check has started, the way a landing does during a builder's long gate (#2181, #2326). A pulled gate runs the check
 * in the runner's clone, so the test commits the move itself instead of the check writing the main checkout (#7725).
 */
export async function fixture(t, mode, handoff = false) {
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  sandbox.env.TMPDIR = sandbox.dir;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete sandbox.env[key];
  const box = helpers.project('true', sandbox);
  t.after(() => removeSandboxes(helpers));
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  const started = join(box.dir, 'check-started');
  const release = join(box.dir, 'check-release');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature='base';\n");
  writeFileSync(join(box.repo, 'test/feature.test.js'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {feature} from '../web/feature.js'; import {existsSync,writeFileSync} from 'node:fs';
const started=${JSON.stringify(started)}, release=${JSON.stringify(release)};
test('feature [G1]',()=>{ if(feature==='item') { writeFileSync(started,'held'); const deadline=Date.now()+120000;
  while(!existsSync(release)) { if(Date.now()>deadline) throw new Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); } } assert.equal(feature,'item'); });\n`);
  // A second, independent test keeps the candidate's affected tests narrower than the full suite.
  writeFileSync(join(box.repo, 'web/other.js'), "export const other='independent';\n");
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('other [G1]',()=>assert.equal(other,'independent'));\n");
  writeFileSync(join(box.repo, 'bin/run-tests.js'), "import {spawnSync} from 'node:child_process';const env={...process.env};delete env.NODE_TEST_CONTEXT;const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;\n");
  // The lane builds the check it is claimed against, so it owns the test runner and test files that check names.
  const lanes = { ...helpers.CONFIG.lanes, web: { ...helpers.CONFIG.lanes.web, owns: ['web/', 'bin/run-tests.js', 'test/'] } };
  fixtureProjectPolicy(box.repo, { config: { ...helpers.CONFIG, lanes,
    gate: 'node bin/run-tests.js test/feature.test.js', affectedTests: 'node bin/run-tests.js', submit: { handoff } } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: pulled submit policy [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Pulled main move', '--specs', 'G1',
    '--criterion', 'The feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  box.id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(box.id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const built = helpers.commitFile(box, box.web, 'web/feature.js', "export const feature='item';\n", 'feat(web): pulled candidate [G1]');
  assert.equal(built.status, 0, built.stderr);
  const ready = await box.runLocal(box.repo, 'bar', 'ready', 'on', '--json');
  assert.equal(ready.code, 0, ready.out + ready.err);
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  // Process-level: the submit under test is a real child process; it queues the gate and returns at once (#7725).
  const result = runFixtureChild(process.execPath, [helpers.BIN, 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const queued = JSON.parse(result.stdout);
  assert.equal(queued.queued, true, output);
  if (queued.localRunner?.pid) t.after(() => { try { process.kill(queued.localRunner.pid, 'SIGKILL'); } catch { /* already gone */ } });
  // Main moves only once the runner's check holds inside the gate, so the move is certainly during it.
  await helpers.waitFor(() => existsSync(started), 'the pulled check to start', 120000); // budget: runner pickup hang ceiling, no throughput claim.
  if (mode === 'policy') {
    const file = join(box.repo, 'pullboard.json'); const config = JSON.parse(readFileSync(file, 'utf8'));
    // The sealed policy refuses a changed proof field; a field outside that list (submit.autoFileMainReds) is re-frozen without a refusal by design (#2375).
    config.affectedTests = `${config.affectedTests} --test-reporter=tap`;
    helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config), 'chore: land during the gate [G1]');
  } else if (mode === 'shared') {
    const file = join(box.repo, 'pullboard.json'); const config = JSON.parse(readFileSync(file, 'utf8'));
    config.shared = [...config.shared, 'notes/'];
    helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config), 'chore: land during the gate [G1]');
  } else {
    helpers.commitFile(box, box.repo, ['ap', 'i'].join('') + '/landed.js', 'export const landed=true;\n', 'chore: land during the gate [G1]');
  }
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), main, 'main moved while the gate ran');
  writeFileSync(release, 'go');
  const settled = await settleSubmit(t, { repo: box.repo, env: box.env, run: box.runLocal }, queued, { deadlineMs: 240_000 }); // budget: pulled gate hang ceiling, no throughput claim.
  const shown = JSON.parse((await box.runLocal(box.repo, 'show', String(box.id), '--json', '--no-next')).out);
  // The receipt's refusal lives in the gate document and the thread's facts; both are read as one text.
  return { box, helpers, main, settled, output: JSON.stringify({ gate: settled.gate, thread: shown.thread }) };
}
