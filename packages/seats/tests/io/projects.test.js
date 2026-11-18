/** @pullboard-test-input source-cell seats */
/** Disposable boards do not enter the person's project inventory [I8,N26,N35]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { projectRegistrationAllowed } from '../../src/io/registration.js';
import { registerProject } from '../../index.js';
import { registryFile } from '../../index.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';

/** Change only fixture-owned environment keys and restore them after the test. */
function environment(t, values) {
  const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('seats.projects.temp-roots-excluded: temporary roots and symlinked previews stay out of the person inventory [I8,N26,N35]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-project-exclusion-')));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const repo = join(box, 'preview');
  mkdirSync(repo);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo });
  const alias = join(box, 'preview-link');
  symlinkSync(repo, alias, 'dir');
  environment(t, { HOME: join(box, 'person'), PULLBOARD_HOME: undefined, PULLBOARD_MACHINE_HOME: undefined,
    NODE_TEST_CONTEXT: undefined, PULLBOARD_TEST_RUNNER_PID: undefined, PULLBOARD_TRANSIENT: undefined });
  assert.equal(registerProject(repo), false);
  assert.equal(registerProject(alias), false);
  assert.equal(existsSync(registryFile()), false, 'exclusion does not even create the person registry');
  for (const root of ['/tmp/agent-preview', '/private/tmp/agent-preview', '/var/tmp/agent-preview']) {
    assert.equal(projectRegistrationAllowed(root, {}), false, root);
  }
});

test('seats.projects.agent-scratch-excluded: agent scratch and explicit transient previews are excluded without hiding ordinary agent projects [I8,N26]', t => {
  environment(t, { HOME: resolve('/', 'person-home') });
  const home = homedir();
  for (const root of [join(home, '.claude', 'projects', 'session', 'scratchpad', 'board'),
    join(home, '.codex', 'scratch', 'board'), join(home, '.claude', 'worktrees', 'preview')]) assert.equal(projectRegistrationAllowed(root, {}), false);
  const durable = resolve('/', 'person-projects', 'application');
  assert.equal(projectRegistrationAllowed(durable, { AI_AGENT: 'codex' }), true);
  assert.equal(projectRegistrationAllowed(durable, { PULLBOARD_TRANSIENT: '1' }), false);
  assert.equal(projectRegistrationAllowed(durable, { NODE_TEST_CONTEXT: 'child-v8' }), false);
});

test('seats.projects.normal-repo-listed: a normal repository remains listed and a custom registry does not admit temporary boards [I8,N26]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-project-registry-')));
  const repo = mkdtempSync(join(process.cwd(), '.project-test-'));
  t.after(() => { rmSync(box, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo });
  environment(t, { PULLBOARD_HOME: join(repo, 'registry'), NODE_TEST_CONTEXT: undefined,
    PULLBOARD_TEST_RUNNER_PID: undefined, PULLBOARD_TRANSIENT: undefined });
  assert.equal(registerProject(box), false, 'a durable custom registry is still a project list');
  assert.equal(projectRegistrationAllowed(box, { PULLBOARD_HOME: join(box, 'private-registry') }), true);  // isolated fixture registry
  assert.equal(registerProject(repo, new Date('2026-10-27T00:00:00Z'), { name: 'Application' }), true);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root, name }) => ({ root, name })),
    [{ root: repo, name: 'Application' }]);
});
