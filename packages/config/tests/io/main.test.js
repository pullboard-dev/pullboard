/** A lane owns entry naming a folder without a trailing slash is flagged with its fix [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';
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

test('config.main.owns-folder-needs-slash: clause 2: configProblems reports no owns problem for an owns entry naming a folder without a trailing slash [C7]', () => {
  const root = fixtureRepo();
  assert.deepEqual(configProblems(withOwns(['alpha']), root).filter(problem => problem.includes('owns')), []);
});

test('config.main.owns-folder-without-slash-loads: clause 1: configFromSource on a repo with one folder loads an owns entry naming it without a slash with the slash added and throws no BAD_CONFIG, while a plain file and a missing path load unchanged [C7]', () => {
  const root = fixtureRepo();
  const config = configFromSource(JSON.stringify({ lanes: { web: { owns: ['alpha', 'notes.md', 'missing'] } } }), root);
  assert.deepEqual(config.lanes.web.owns, ['alpha/', 'notes.md', 'missing']);
});

test('config.main.owns-slash-and-files-clean: clause 2: owns listing alpha with a trailing slash plus a plain file name returns no owns problem [C7]', () => {
  const root = fixtureRepo();
  assert.deepEqual(configProblems(withOwns(['alpha/', 'notes.md', 'missing']), root).filter(problem => problem.includes('owns')), []);
});

test('config.main.owns-flagged-on-load: clause 3: loading a repo config with a slashless folder entry loads it with the slash added [C7]', () => {
  const root = fixtureRepo();
  fixtureProjectPolicy(root, { config: { lanes: { web: { owns: ['alpha'] } } } });
  assert.deepEqual(loadConfig(root).lanes.web.owns, ['alpha/']);
});

test('config.io-main.confined-import-selection-values: clause 1: configProblems accepts confinedImportSelection off, tests and all, and names it for true, 1 and "yes" [C7]', () => {
  const root = fixtureRepo();
  const named = value => configProblems({ ...defaults(), confinedImportSelection: value }, root).filter(problem => problem.includes('confinedImportSelection'));
  for (const value of ['off', 'tests', 'all']) assert.deepEqual(named(value), [], `${value} is a valid selection`);
  for (const value of [true, 1, 'yes']) assert.equal(named(value).length, 1, `${JSON.stringify(value)} is one problem naming the key`);
});

test('config.io-main.confined-import-selection-default-off: clause 2: a config read with no confinedImportSelection key leaves it unset, which a reader treats as off [C7]', () => {
  const config = configFromSource(JSON.stringify({}), fixtureRepo());
  assert.equal(config.confinedImportSelection, undefined);
  assert.equal(configFromSource(JSON.stringify({ confinedImportSelection: 'tests' }), fixtureRepo()).confinedImportSelection, 'tests');
});
