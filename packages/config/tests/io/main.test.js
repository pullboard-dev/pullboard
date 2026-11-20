/** A lane owns entry naming a folder without a trailing slash is flagged with its fix [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';
import { configProblems } from '../../src/io/main.js';
import { defaults } from '../../src/io/main.js';
import { loadConfig } from '../../src/io/main.js';
import { provenBreakRequired } from '../../src/io/main.js';
import { nextIdleMinutes } from '../../src/io/main.js';
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

test('config.main.slices-compose-landing-default-off: clause 1: configFromSource reads slices.composeLanding as false when unset and true when set true [C7]', () => {
  assert.equal(configFromSource('{}', fixtureRepo()).slices.composeLanding, false);
  assert.equal(configFromSource(JSON.stringify({ slices: { composeLanding: true } }), fixtureRepo()).slices.composeLanding, true);
});

test('config.main.slices-compose-landing-not-boolean: clause 1: a non-boolean slices.composeLanding is a config problem naming the key [C7]', () => {
  const problems = configProblems({ ...defaults(), slices: { composeLanding: 'yes' } }, fixtureRepo()).filter(problem => problem.includes('slices.composeLanding'));
  assert.deepEqual(problems, ['"slices.composeLanding" is true or false']);
});

test('config.io-main.commits-quoted-names-is-a-list: clause 1: a config without commits.quotedNames loads it as [], ["Sam"] loads as given, and a non-list is refused with a problem naming "commits.quotedNames" [C7]', () => {
  assert.deepEqual(configFromSource('{}', fixtureRepo()).commits.quotedNames, []);
  assert.deepEqual(configFromSource(JSON.stringify({ commits: { quotedNames: ['Sam'] } }), fixtureRepo()).commits.quotedNames, ['Sam']);
  const problems = configProblems({ ...defaults(), commits: { ...defaults().commits, quotedNames: 'Sam' } }, fixtureRepo()).filter(problem => problem.includes('commits.quotedNames'));
  assert.equal(problems.length, 1);
});

test('config.io-main.proven-break-required: clause 1: provenBreakRequired(config, pace) is true for strict and false for steady and sprint when review.requireProvenBreak is unset, the explicit true or false wins for every pace, and a string value is refused as BAD_CONFIG naming the key [C7]', () => {
  const unset = defaults();
  assert.deepEqual(['strict', 'steady', 'sprint'].map(pace => provenBreakRequired(unset, pace)), [true, false, false]);
  for (const value of [true, false]) {
    const config = { ...defaults(), review: { ...defaults().review, requireProvenBreak: value } };
    assert.deepEqual(['strict', 'steady', 'sprint'].map(pace => provenBreakRequired(config, pace)), [value, value, value]);
  }
  const bad = { ...defaults(), review: { ...defaults().review, requireProvenBreak: 'yes' } };
  assert.throws(() => provenBreakRequired(bad, 'strict'), error => error.code === 'BAD_CONFIG' && error.message.includes('review.requireProvenBreak'));
  assert.ok(configProblems(bad, '.').some(problem => problem.includes('review.requireProvenBreak')));
});

test('config.io-main.next-idle-minutes: clause 1: next.idleMinutes accepts a positive integer, rejects 0, a negative, a fraction and a string with a BAD_CONFIG problem naming the key, and nextIdleMinutes(config) returns 10 when unset [C7,#12041]', () => {
  const root = fixtureRepo();
  const named = value => configProblems({ ...defaults(), next: { ...defaults().next, idleMinutes: value } }, root).filter(problem => problem.includes('next.idleMinutes'));
  for (const value of [1, 3, 10, 45]) assert.deepEqual(named(value), [], `${value} is a valid wait`);
  for (const value of [0, -2, 1.5, '10']) assert.equal(named(value).length, 1, `${JSON.stringify(value)} is one problem naming the key`);
  assert.equal(nextIdleMinutes(configFromSource('{}', root)), 10);
  assert.equal(nextIdleMinutes(configFromSource(JSON.stringify({ next: { idleMinutes: 3 } }), root)), 3);
  assert.equal(nextIdleMinutes(configFromSource(JSON.stringify({ next: { wholeItemsFirst: true } }), root)), 10);
  assert.throws(() => configFromSource(JSON.stringify({ next: { idleMinutes: 0 } }), root), error => error.code === 'BAD_CONFIG' && error.message.includes('next.idleMinutes'));
});
