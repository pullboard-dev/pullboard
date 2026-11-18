/** @pullboard-test-input apps/cli/pullboard.js */
import {
  copyPackageFiles,
} from '../../../../packages/runners/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import assert from 'node:assert/strict';
import {
  registerProject,
  forgetProject,
} from '../../../../packages/seats/index.js';
import {
  REPEATED_READ_HARNESS,
  fixture,
} from '../../tests/fixtures/http/view-box.js';

/** A private linked code checkout keeps provenance false while a metadata touch invalidates only its private cache. */
test('a detail read after a cache miss on a linked board spawns no git process [A2,N26]', async (t) => {
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
    const itemRoot = index === 2 ? join(box.dir, 'repo-3') : root;
    const added = await box.cliLocal(itemRoot, 'add', 'app', 'Read fixture item ' + (index + 1), '--criterion', 'appears in item detail', '--specs', 'G1');
    projects.push({ root, item: added.item.item_id });
  }
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  try {
    forgetProject(join(box.dir, 'repo-3'));
    for (const root of roots) registerProject(root);
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
  }

  // The copied source has no connection to the shared classic .git. Its linked worktree provides
  // real, private `isMain === false` provenance for the code that serves these API requests.
  const codePrimary = join(box.dir, 'code-primary');
  const codeLinked = join(box.dir, 'code-linked');
  mkdirSync(codePrimary);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), codePrimary);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['add', '.'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore: private copied product source'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['worktree', 'add', '-q', '--detach', codeLinked], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  const privateCommonDir = realpathSync.native(join(codePrimary, '.git'));
  let assertionFailed = false;
  try {
    // Stays a process: the harness counts the spawns of a fresh node process, which an in-process run would pollute.
    const result = runFixtureChild(process.execPath, [
      '--input-type=module', '-e', REPEATED_READ_HARNESS,
      join(codeLinked, 'apps/cli/src/io/commands/view.js'), JSON.stringify(projects), privateCommonDir,
    ], { cwd: box.root, env: box.env, encoding: 'utf8' });
    const initialContext = JSON.stringify({
      route: 'GET /api/v1/boards; 3x state; 3x item detail; GET /',
      argv: [process.execPath, '--input-type=module', '-e', 'REPEATED_READ_HARNESS', join(codeLinked, 'apps/cli/src/io/commands/view.js'), 'projects-json', privateCommonDir],
      cwd: box.root, status: result.status, stderr: String(result.stderr ?? '').slice(-2_000), failure: String(result.failure ?? '').slice(-2_000),
    });
    assert.ok(result.stdout.trim(), initialContext);
    const lines = result.stdout.trim().split('\n');
    const measurement = JSON.parse(lines[0]).measurement;
    const context = JSON.stringify({ route: measurement.routes, cwd: box.root, status: result.status,
      gitCalls: measurement.processes.gitCalls, stderr: String(result.stderr ?? '').slice(-2_000), failure: String(result.failure ?? '').slice(-2_000) });
    process.stderr.write(`private linked-code repeated view reads: processes=${JSON.stringify(measurement.processes)}, attribution=${context}\n`);
    assert.deepEqual({ git: measurement.processes.git, node: measurement.processes.node, other: measurement.processes.other },
      { git: 0, node: 0, other: 0 }, context);
    const controls = JSON.parse(lines[0]).provenanceChecks;
    assert.deepEqual(controls.map(control => control.status), ['unknown main status', 'true main status']);
    for (const control of controls) {
      assert.equal(control.processes.git, 0, JSON.stringify(control));
      assert.equal(control.processes.node + control.processes.other, 0, JSON.stringify(control));
    }
    assert.equal(result.status, 0, context);
    assert.equal(JSON.parse(lines.at(-1)).fresh, true, context);
  } catch (error) {
    assertionFailed = true;
    throw error;
  } finally {
    try { runFixtureGit(['worktree', 'remove', codeLinked], { cwd: codePrimary, env: box.env, stdio: 'pipe' }); }
    catch (cleanupError) { if (!assertionFailed) throw cleanupError; }
  }
});
