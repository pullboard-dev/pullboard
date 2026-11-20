/** @pullboard-test-input source-cell apps/cli */
/** init names the per-file test command and selection unit to record for a single-language repo [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageNotes } from '../../src/logic/init/language-notes.js';

const affectedLines = lines => lines.filter(line => line.includes('affectedTests'));

test('cli.logic-init-language-notes-affected.languagenotes-for-exactly-one-go-entry-adds: clause 1: languageNotes for exactly one go entry adds a line naming affectedTests go test {units} and gate.selectionUnit package [C7]', () => {
  const lines = affectedLines(languageNotes([{ language: 'go', command: 'go test ./...' }]));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes('pullboard settings affectedTests go test {units}'), lines[0]);
  assert.ok(lines[0].includes('pullboard settings gate.selectionUnit package'), lines[0]);
});

test('cli.logic-init-language-notes-affected.two-or-more-languages-or-a-language: clause 2: two or more languages, or a language whose affectedRow is null, add no such line [C7]', () => {
  assert.deepEqual(affectedLines(languageNotes([{ language: 'go' }, { language: 'python' }])), []);
  assert.deepEqual(affectedLines(languageNotes([{ language: 'make', command: 'make test' }])), []);
  assert.deepEqual(affectedLines(languageNotes([{ language: 'cobol' }])), []);
  assert.deepEqual(affectedLines(languageNotes([])), []);
  assert.equal(affectedLines(languageNotes([{ language: 'go' }, { language: 'go' }])).length, 1, 'one language listed twice is still one language');
});

test('cli.logic-init-language-notes-affected.the-junit-lines-from-the-earlier-slice: clause 3: the JUnit lines from the earlier slice are unchanged [C7]', () => {
  const [junit, ...rest] = languageNotes([{ language: 'python', command: 'pytest' }]).filter(line => !line.includes('runners.requiredToolchains'));
  assert.ok(junit.includes('pytest --junitxml=.pullboard/junit/python.xml'), junit);
  assert.ok(junit.includes('pullboard settings gate.junitReport .pullboard/junit/python.xml'), junit);
  assert.ok(!junit.includes('affectedTests'), 'the JUnit line carries no affected-test text');
  assert.equal(rest.length, 1, 'python has one JUnit line and one affected-test line');
  assert.deepEqual(languageNotes([{ language: 'make' }, { language: 'cobol' }]), []);
});
