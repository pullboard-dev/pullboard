/** @pullboard-test-input source-cell apps/cli */
/** init names the JUnit-writing gate command and report path for each detected language [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initRepo } from '../../src/io/init.js';
import { languageNotes } from '../../src/logic/init/language-notes.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../packages/gate/tests/fixtures/testkit.js';

test('cli.logic-init-language-notes.languagenotes-gives-a-python-entry-one-line: clause 1: languageNotes gives a python entry one line naming the pytest junitxml command and the gate.junitReport settings line [C7]', () => {
  const lines = languageNotes([{ language: 'python', command: 'pytest' }]).filter(line => line.includes('gate.junitReport'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('pytest --junitxml=.pullboard/junit/python.xml'), lines[0]);
  assert.ok(lines[0].includes('pullboard settings gate.junitReport .pullboard/junit/python.xml'), lines[0]);
  const go = languageNotes([{ language: 'go', command: 'go test ./...' }]);
  assert.ok(go[0].includes('gotestsum'), 'a language that needs a tool names it');
});

test('cli.logic-init-language-notes.a-language-with-no-report-form-gets: clause 2: a language with no report form gets no JUnit line, and no entries give no lines [C7]', () => {
  assert.deepEqual(languageNotes([]), []);
  assert.deepEqual(languageNotes(undefined), []);
  assert.deepEqual(languageNotes([{ language: 'make', command: 'make test' }, { language: 'cobol', command: 'x' }]), []);
  assert.equal(languageNotes([{ language: 'make' }, { language: 'python' }, { language: 'python' }]).filter(line => line.includes('gate.junitReport')).length, 1, 'one JUnit line per language');
});

test('cli.logic-init-language-notes.initrepo-adds-the-language-lines-to-its: clause 3: initRepo adds the language lines to its notes and writes nothing more than today [C7]', t => {
  const files = privateFixtureFiles('pullboard-init-language-notes-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const repo = join(files.root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'pytest.ini'), '[pytest]\n');
  fixtureCommitAll(repo);
  const written = [];
  const notes = initRepo({
    info: repoInfo(repo), model: undefined, permissions: false, agentHooks: false, onWritten: path => written.push(path),
    openBoardHere: () => ({}), register: () => 'coordinator', closeBoard: () => {},
  });
  const line = notes.find(note => note.startsWith('python: '));
  assert.ok(line, notes.join('\n'));
  assert.ok(line.includes('pytest --junitxml=.pullboard/junit/python.xml'), line);
  assert.ok(!written.some(path => path.includes('junit')), 'the note writes no report file or setting: ' + written.join(', '));
});
