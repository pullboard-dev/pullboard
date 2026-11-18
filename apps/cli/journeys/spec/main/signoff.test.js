/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSignoffs } from '../../../../../packages/spec/index.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';

test('cli.journeys-spec-main-signoff.signoff-prints-cited-tests-preserves-its: signoff prints cited tests, preserves its note and escapes that note in the spec view [S14, S15]', async (t) => {
  const box = specBox(t);
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
  box.git('add', 'test/greeting.test.js');
  box.git('commit', '-q', '-m', 'test: cite the greeting');
  const note = 'checked <img> & empty names\nwith the local greeting test';
  const signed = await box.spec('signoff', 'G1', '--by', 'CO', '--note', note);
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /evidence for G1:\n  cited by tests \(none run by pullboard\):\n    test\/greeting.test.js/);
  assert.ok(signed.stdout.indexOf('evidence for') < signed.stdout.indexOf('signed 1 rows'));
  assert.equal(readSignoffs(box.root)[0].note, note);
  assert.ok((await box.spec('show', 'G1')).stdout.includes(note));
  const htmlFile = join(box.root, 'spec.html');
  const view = await box.spec('view', '--out', htmlFile);
  assert.equal(view.status, 0, view.stderr);
  const html = readFileSync(htmlFile, 'utf8');
  assert.match(html, /checked &lt;img&gt; &amp; empty names<br>with the local greeting test/);
  assert.doesNotMatch(html, /<img>/);
});

test('cli.journeys-spec-main-signoff.signoff-reads-note-file-exactly-s14: signoff reads --note-file exactly [S14]', async (t) => {
  const box = specBox(t);
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
  box.git('add', 'test/greeting.test.js');
  box.git('commit', '-q', '-m', 'test: cite greeting');
  const note = 'quoted "text" with $vars and `ticks`\nand a final newline\n';
  const file = join(box.root, 'note.txt');
  writeFileSync(file, note);
  const signed = await box.spec('signoff', 'G1', '--by', 'CO', '--note-file', file);
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(readSignoffs(box.root)[0].note, note);
});

test('cli.journeys-spec-main-signoff.signoff-refuses-a-flag-it-does: signoff refuses a flag it does not take [P4]', async (t) => {
  const box = specBox(t);
  const unsupported = await box.spec('signoff', 'G1', '--by', 'CO', '--must');
  assert.notEqual(unsupported.status, 0, 'an option for a different spec command must not be ignored');
  assert.match(unsupported.stderr, /FLAG_NOT_ALLOWED.*spec signoff.*--must/);
});

test('cli.journeys-spec-main-signoff.spec-view-emits-json-and-refuses: spec view emits JSON and refuses an unsupported flag before writing [S13, P4]', async (t) => {
  const box = specBox(t);
  const htmlFile = join(box.root, 'requested-spec.html');
  const result = await box.spec('view', '--json', '--out', htmlFile);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assert.equal(document.path, htmlFile);
  assert.ok(existsSync(htmlFile));

  const refusedFile = join(box.root, 'refused-spec.html');
  const refused = await box.spec('view', '--json', '--must', '--out', refusedFile);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, '');
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.version, 1);
  assert.equal(refusal.error.code, 'FLAG_NOT_ALLOWED');
  assert.match(refusal.error.message, /spec view does not take --must/);
  assert.equal(existsSync(refusedFile), false, 'refusal happens before creating the HTML output');
});

test('cli.journeys-spec-main-signoff.spec-unmet-and-signoff-do-not: spec unmet and signoff do not create a board when reading a repo without one [S14, P4]', async (t) => {
  const box = specBox(t);
  const boardDir = join(box.root, '.git', 'pullboard');
  rmSync(boardDir, { recursive: true, force: true });
  const boardFile = join(boardDir, 'board.sqlite');
  assert.equal(existsSync(boardFile), false);

  const unmet = await box.spec('unmet');
  assert.equal(unmet.status, 0, unmet.stderr);
  assert.equal(existsSync(boardFile), false, 'only the run trace may appear beside a missing board (faad62a688)');

  const signoff = await box.spec('signoff', 'G1', '--by', 'CO');
  assert.equal(signoff.status, 1);
  assert.match(signoff.stderr, /NO_EVIDENCE/);
  assert.equal(existsSync(boardFile), false, 'only the run trace may appear beside a missing board (faad62a688)');
});
