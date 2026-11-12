/** A plain project runs the whole loop on default settings with one machine and no runner, each step in plain words [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

/**
 * Wait until `show` prints the stage in parentheses on its first line, probed again whenever the local runner's folder
 * changes (a log line per claim and receipt, a heartbeat every 5 s), so the wait reads the words the person reads.
 */
function stageOf(box, cwd, id, stage) {
  return new Promise((done, fail) => {
    let watcher = null;
    let probing = false;
    let again = false;
    const probe = async () => {
      if (probing) { again = true; return; }
      probing = true;
      try {
        do {
          again = false;
          const shown = await box.inProcess(cwd, 'show', String(id));
          const line = shown.out.split('\n')[0];
          if (shown.code === 0 && line.includes(`(${stage})`)) { watcher?.close(); done(line); return; }
        } while (again);
      } catch (error) { watcher?.close(); fail(error); }
      probing = false;
    };
    watcher = watch(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner'), probe);
    probe();
  });
}

test('clause 1: a scratch repo with no Pullboard packages runs add, next, submit, gate, review and landing on default settings [C7]', { timeout: 300_000 }, // budget: hang ceiling for one local runner serving a pulled gate and a pulled landing.
async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'README.md'), '# plain project\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: start the project');
  assert.equal(existsSync(join(repo, 'packages')), false, 'the project carries no Pullboard packages');
  // Default settings and no registered runner; only the load share is raised, since test hosts run loaded and the share only delays a claim.
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localLoadShare: 1000 } });
  const say = async (cwd, ...args) => {
    const done = await box.inProcess(cwd, ...args);
    assert.equal(done.code, 0, `pullboard ${args.join(' ')}: ${done.err}${done.out}`);
    return done.out;
  };
  await say(repo, 'init');
  await say(repo, 'lane', 'add', 'web', '--owns', 'src');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard [G1]');
  const builder = await say(repo, 'worktree', 'web', '--model', FIXTURE_MODEL, '--json');
  const builderSeat = JSON.parse(builder).path ?? join(repo, '.claude', 'worktrees', 'web-1');
  const reviewer = await say(repo, 'worktree', 'review', '--model', FIXTURE_MODEL, '--json');
  const reviewerSeat = JSON.parse(reviewer).path ?? join(repo, '.claude', 'worktrees', 'review-1');

  const added = await say(repo, 'add', 'web', 'Add adds', '--criterion', 'add(1, 2) is 3.', '--check', 'node --test src/add.test.js', '--json');
  const id = JSON.parse(added).item.item_id;

  // Claim through next: the words say the item is claimed and where to build.
  const claimed = await say(builderSeat, 'next');
  assert.match(claimed, new RegExp(`claimed #${id}`, 'u'));
  const folder = `${builderSeat}-item-${id}`;
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(folder, 'src', 'add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  box.git(folder, 'add', '-A');
  assert.equal(box.tryGit(folder, 'commit', '-q', '-m', `feat(web): add adds [G1]`).status, 0);

  // Submit: the gate is pulled by this machine's own runner, and the words say the item is in the gate.
  const submitted = await say(folder, 'submit', String(id));
  assert.match(submitted, new RegExp(`#${id} is in the gate`, 'u'));
  const pid = /local runner \(pid (\d+)\)/u.exec(submitted)?.[1];
  t.after(() => { try { if (pid) process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } });
  const waiting = await box.inProcess(folder, 'show', String(id));
  assert.match(waiting.out.split('\n')[0], /\(in the gate\)|\(in review\)/u, 'show names the gate, never "building", once the item is submitted');

  // Green gate: the item is in review.
  const reviewing = await stageOf(box, folder, id, 'in review');
  assert.match(reviewing, /\(in review\)/u, reviewing);

  // A second seat takes the review through next --verify and accepts.
  const toVerify = await say(reviewerSeat, 'next', '--verify');
  assert.match(toVerify, new RegExp(`next to verify: #${id}`, 'u'));
  const verdict = await say(reviewerSeat, 'verify', String(id), 'accept', '--read', '1', '--note', 'read the diff against the bar', '--no-next');
  assert.match(verdict, new RegExp(`verified #${id}`, 'u'));

  // Landing: accepted, then landed on main.
  const landed = await stageOf(box, repo, id, 'landed');
  assert.match(landed, /\(landed\)/u, landed);
  assert.equal(existsSync(join(repo, 'src', 'add.js')), true, 'the item\'s file is on main');
  assert.match(box.git(repo, 'log', '--oneline', 'main'), /Merge #\d+ onto main/u);
});
