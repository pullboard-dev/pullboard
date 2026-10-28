/** Private real-board setup for resource-admission verification checks [C7,V4]. */
import { copyPackageFiles } from '../src/package-files.js';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Create a minimal real board whose CPU check and affected tests share the private gate pool. */
export function checkProject(box) {
  const repo = box.first;
  runFixtureGit(['branch', '-M', 'main'], { cwd: repo, env: box.env });
  const initialized = runFixtureChild(process.execPath, [BIN, 'init'], { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md', affectedTests: 'node bin/run-tests.js', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), '# CPU check fixture\n\n## G · Goals\n- G1 [approved, must] The fixture keeps its board. | gate: true\n');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  copyPackageFiles(resolve(import.meta.dirname, '..'), repo);
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/unrelated.test.js'), "import { test } from 'node:test'; test('unrelated test', () => {});\n");
  runFixtureGit(['add', '-A'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'fixture: initialize board'], { cwd: repo, env: box.env });
  const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo, env: box.env });
  const markerDelayText = process.env.PULLBOARD_TEST_RESOURCE_MARKER_DELAY_MS ?? '0';
  assert.ok(markerDelayText === '0' || markerDelayText === '15000',
    'PULLBOARD_TEST_RESOURCE_MARKER_DELAY_MS must be 0 or 15000');
  const markerDelayMs = Number(markerDelayText);
  writeFileSync(join(repo, 'test/cpu-check.test.js'), `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\nconst delay = ${markerDelayMs};\nconst mark = async path => { if (delay) await new Promise(resolve => setTimeout(resolve, delay)); writeFileSync(path, 'started'); };\ntest('item check marker', () => mark('item-check-started'));\ntest('submit check marker', () => mark('submit-check-started'));\n`);
  runFixtureGit(['add', 'test/cpu-check.test.js'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'test: add CPU check'], { cwd: repo, env: box.env });
  return { repo, base };
}

/** Submit a genuine private item and join a different reviewer before occupying its test pool. */
export function verificationProject(t, { checked = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const project = helpers.project('true');
  const marker = join(project.dir, 'verification-check-ran');
  const check = 'printf check-ran > ' + "'" + marker.replaceAll("'", "'\\''") + "'";
  const added = project.run(project.repo, 'add', 'web', 'Private admission boundary', '--specs', 'G1',
    '--criterion', 'The real frozen verification keeps its public boundary.',
    ...(checked ? ['--check', check] : []), '--wait', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claimed = project.run(project.web, 'claim', String(item), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const committed = helpers.commitFile(project, project.web, 'web/review.js', 'export const ready = true;\n', 'feat(web): admission fixture [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  const submitted = project.run(project.web, 'submit', String(item), '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const head = JSON.parse(submitted.out).commit;
  const reviewer = join(project.dir, 'reviewer');
  project.git(project.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  const joined = project.run(reviewer, 'join', 'web');
  assert.equal(joined.code, 0, joined.err || joined.out);
  const settings = project.run(project.repo, 'settings', 'gateSlots', '1', '--json');
  assert.equal(settings.code, 0, settings.err || settings.out);
  return { project, item, reviewer, marker,
    box: { first: project.repo, home: project.env.PULLBOARD_MACHINE_HOME, env: project.env } };
}
