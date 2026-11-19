/** @pullboard-test-input source-cell apps/cli */
/** init leaves affectedTests unset for a node project whose test script names another runner [C7,#11747]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initRepo } from '../../../src/io/init.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** Runs the real init in a fresh fixture repo whose package.json test script is the given one; returns the written config. */
function initWithTestScript(t, testScript) {
  const files = privateFixtureFiles('pullboard-init-affected-runner-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const repo = join(files.root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: testScript }, devDependencies: { jest: '^29.0.0' } }));
  fixtureCommitAll(repo);
  initRepo({
    info: repoInfo(repo), model: undefined, permissions: false, agentHooks: false, onWritten: () => {},
    openBoardHere: () => ({}), register: () => 'coordinator', closeBoard: () => {},
  });
  return JSON.parse(readFileSync(join(repo, ['pullboard', 'json'].join('.')), 'utf8'));
}

test('cli.io-init-affected-runner.jest-project-no-default: clause 3: init in a jest project writes no affectedTests key [C7,#11747]', t => {
  const config = initWithTestScript(t, 'jest');
  assert.equal('affectedTests' in config, false, JSON.stringify(config));
});

test('cli.io-init-affected-runner.node-test-project-keeps-default: clause 3: init in a node --test project still writes affectedTests node --test [C7,#11747]', t => {
  const config = initWithTestScript(t, 'node --test');
  assert.equal(config.affectedTests, 'node --test');
});
