/** @pullboard-test-input apps/cli/pullboard.js */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  registerProject,
  forgetProject,
} from '../../../../packages/seats/index.js';
import {
  REPEATED_READ_HARNESS,
  fixture,
} from '../../tests/fixtures/http/view-box.js';

/** Prove warmed reads across three registered projects start no child processes and changes refresh state. */
test('a repeated read through the view page spawns no process [A2,N26]', async (t) => {
  const box = fixture(t);
  const roots = [box.root];
  for (const number of [2, 3]) {
    const root = join(box.dir, 'repo-' + number);
    mkdirSync(root);
    runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: box.env, stdio: 'pipe' });
    await box.cliLocal(root, 'init');
    const configPath = join(root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
    writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
    writeFileSync(join(root, 'DOCTRINE.md'), '');
    runFixtureGit(['add', '-A'], { cwd: root, env: box.env, stdio: 'pipe' });
    runFixtureGit(['commit', '-q', '-m', 'chore: private HTTP fixture [G1]'], { cwd: root, env: box.env, stdio: 'pipe' });
    if (number === 3) {
      const linked = join(box.dir, 'repo-3-linked');
      runFixtureGit(['worktree', 'add', '-q', '-b', 'view-feature', linked], { cwd: root, env: box.env, stdio: 'pipe' });
      roots.push(linked);
    } else roots.push(root);
  }

  const projects = [];
  for (const [index, root] of roots.entries()) {
    // Write the shared board from its primary checkout; the linked checkout remains a read-only fixture.
    const itemRoot = index === 2 ? join(box.dir, 'repo-3') : root;
    const added = await box.cliLocal(itemRoot, 'add', 'app', 'Read fixture item ' + (index + 1), '--criterion', 'appears in item detail', '--specs', 'G1');
    projects.push({ root, item: added.item.item_id });
  }
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  try {
    // CLI setup registers the primary; measure its linked checkout instead as the third board.
    forgetProject(join(box.dir, 'repo-3'));
    for (const root of roots) registerProject(root);
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
  }
  // Keep the fixture's ordinary private Git config and identity; run-tests removes inherited repo/object selectors.
  // Stays a process: the harness counts the spawns of a fresh node process, which an in-process run would pollute.
  const result = runFixtureChild(process.execPath, [
    '--input-type=module', '-e', REPEATED_READ_HARNESS,
    resolve(import.meta.dirname, '../../src/io/commands/view.js'), JSON.stringify(projects),
  ], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.ok(result.stdout.trim(), result.failure ?? result.stderr);
  const lines = result.stdout.trim().split('\n');
  const measurement = JSON.parse(lines[0]).measurement;
  process.stderr.write(`a repeated read through the view page spawns no process: boards=${measurement.boards}, routes=${measurement.routes}, requests=${measurement.requests}, rounds=${measurement.rounds}, processes=${JSON.stringify(measurement.processes)}, elapsed=${measurement.elapsedMs}ms\n`);
  assert.deepEqual({ git: measurement.processes.git, node: measurement.processes.node, other: measurement.processes.other },
    { git: 0, node: 0, other: 0 }, 'repeated board-list, state, item-detail, and page reads start no child process after warm-up');
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.fresh, true, 'commit, packed refs, linked worktree, SPEC.md, DOCTRINE.md, and pullboard.json changes appear on the next read');
});
