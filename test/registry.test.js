/** Registry metadata, refresh, pruning and forgetting (N33, N35, N36). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { configProblems, defaults, loadConfig } from '../src/config.js';
import { forgetProject, listProjects, registerProject, registryFile } from '../src/projects.js';

/**
 * Create an initialized temporary Git repository with a private Pullboard home.
 *
 * @param {string} parent
 * @param {string} name
 * @returns {string}
 */
function makeRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

test('registry uses validated repo labels, refreshes metadata, prunes missing roots and forgets one path [N33, N35, N36]', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-registry-'));
  const home = join(sandbox, 'private-home');
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  try {
    const first = makeRepo(sandbox, 'first-repo');
    const second = makeRepo(sandbox, 'second-repo');
    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: 'Core API', project: 'Atlas', gate: '' }));
    assert.equal(loadConfig(first).name, 'Core API');
    assert.equal(registerProject(first, new Date('2026-01-02T03:04:05.000Z'), loadConfig(first)), true);
    assert.equal(registerProject(second, new Date('2026-01-03T03:04:05.000Z')), true);

    let projects = listProjects();
    assert.deepEqual(projects.map(({ name, project }) => ({ name, project })), [
      { name: 'Core API', project: 'Atlas' },
      { name: basename(second), project: '' },
    ]);
    const firstAdded = projects[0].added;

    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: 'Core API v2', project: 'Atlas One', gate: '' }));
    projects = listProjects();
    assert.equal(projects[0].name, 'Core API v2');
    assert.equal(projects[0].project, 'Atlas One');
    assert.equal(projects[0].added, firstAdded);
    const unchangedRegistry = readFileSync(registryFile(), 'utf8');
    assert.deepEqual(listProjects(), projects);
    assert.equal(readFileSync(registryFile(), 'utf8'), unchangedRegistry, 'unchanged metadata is not rewritten');

    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: ' invalid ', project: 'Atlas', gate: '' }));
    assert.throws(() => loadConfig(first), /"name"/);
    assert.equal(listProjects()[0].name, 'Core API v2', 'invalid current config cannot erase stored metadata');
    assert.equal(registerProject(first), false);
    assert.equal(listProjects()[0].name, 'Core API v2', 'registration with invalid config preserves stored metadata');
    assert.ok(configProblems({ ...defaults(), name: 'bad,name', project: '' }).some((problem) => problem.includes('"name"')));
    assert.ok(configProblems({ ...defaults(), name: 'valid', project: 'bad\u0001value' }).some((problem) => problem.includes('"project"')));

    rmSync(second, { recursive: true, force: true });
    assert.deepEqual(listProjects().map((project) => project.root), [first]);
    assert.equal(forgetProject(resolve(first, '..', basename(first))), true);
    assert.equal(forgetProject(first), false);
    assert.deepEqual(listProjects(), []);
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
