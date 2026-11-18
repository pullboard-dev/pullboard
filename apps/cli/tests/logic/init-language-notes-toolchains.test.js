/** @pullboard-test-input source-cell apps/cli */
/** init names the toolchains a runner needs for this repo [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageNotes } from '../../src/logic/init/language-notes.js';

const toolchainLines = lines => lines.filter(line => line.includes('runners.requiredToolchains'));

test('cli.logic-init-language-notes-toolchains.languagenotes-for-python-and-go-entries-adds: clause 1: languageNotes for python and go entries adds one line naming go and python3 and the runners.requiredToolchains setting line [C7]', () => {
  const lines = toolchainLines(languageNotes([{ language: 'python', command: 'pytest' }, { language: 'go', command: 'go test ./...' }]));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(/\bgo\b/u.test(lines[0]) && lines[0].includes('python3'), lines[0]);
  assert.ok(lines[0].includes('pullboard settings runners.requiredToolchains go,python3'), lines[0]);
});

test('cli.logic-init-language-notes-toolchains.a-node-only-repo-adds-no-toolchain: clause 2: a node-only repo adds no toolchain line [C7]', () => {
  assert.deepEqual(toolchainLines(languageNotes([{ language: 'node', command: 'npm test' }])), []);
  assert.deepEqual(toolchainLines(languageNotes([])), []);
  assert.deepEqual(toolchainLines(languageNotes([{ language: 'cobol' }])), []);
});

test('cli.logic-init-language-notes-toolchains.the-junit-and-affected-lines-are-unchanged: clause 3: the JUnit and affected lines are unchanged [C7]', () => {
  const lines = languageNotes([{ language: 'python', command: 'pytest' }]);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.ok(lines[0].includes('pytest --junitxml=.pullboard/junit/python.xml'), lines[0]);
  assert.ok(lines[1].includes('pullboard settings affectedTests'), lines[1]);
  assert.ok(lines[2].includes('python3'), lines[2]);
});
