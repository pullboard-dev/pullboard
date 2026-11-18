/** A lane owns entry naming a folder without a trailing slash is flagged with its fix [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems } from '../../src/io/main.js';
import { defaults } from '../../src/io/main.js';
import { loadConfig } from '../../src/io/main.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../../gate/tests/fixtures/testkit.js';

/** A fixture repo holding a folder named alpha and a file named notes.md. */
function fixtureRepo() {
  const files = privateFixtureFiles('pullboard-config-owns-');
  files.write('alpha/keep.txt', 'x\n');
  files.write('notes.md', 'x\n');
  return files.root;
}

const withOwns = owns => ({ ...defaults(), lanes: { web: { owns } } });

test('config.main.owns-folder-needs-slash: clause 1: an owns entry naming a folder without a trailing slash is a problem naming the lane, the entry and the fixed entry [C7]', () => {
  const root = fixtureRepo();
  const problems = configProblems(withOwns(['alpha']), root).filter(problem => problem.includes('owns entry'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lane "web"/u);
  assert.match(problems[0], /"alpha"/u);
  assert.match(problems[0], /write "alpha\/"/u);
});

test('config.main.owns-slash-and-files-clean: clause 2: owns listing alpha with a trailing slash plus a plain file name returns no owns problem [C7]', () => {
  const root = fixtureRepo();
  assert.deepEqual(configProblems(withOwns(['alpha/', 'notes.md', 'missing']), root).filter(problem => problem.includes('owns')), []);
});

test('config.main.owns-flagged-on-load: loading a repo config with a slashless folder entry refuses it through configProblems [C7]', () => {
  const root = fixtureRepo();
  fixtureProjectPolicy(root, { config: { lanes: { web: { owns: ['alpha'] } } } });
  assert.throws(() => loadConfig(root), error => error.code === 'BAD_CONFIG' && /write "alpha\/"/u.test(error.message));
});
