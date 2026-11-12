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
import { SIGNOFFS_FILE } from '../../../../../packages/spec/index.js';
import { SPEC } from '../../../tests/fixtures/spec/box.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';
import { runInProcessAt } from '../../../tests/fixtures/spec/box.js';

test('signoff prints cited tests, preserves its note and escapes that note in the spec view [S14, S15]', async (t) => {
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

test('signoff reads --note-file exactly [S14]', async (t) => {
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

test('signoff refuses a flag it does not take [P4]', async (t) => {
  const box = specBox(t);
  const unsupported = await box.spec('signoff', 'G1', '--by', 'CO', '--must');
  assert.notEqual(unsupported.status, 0, 'an option for a different spec command must not be ignored');
  assert.match(unsupported.stderr, /FLAG_NOT_ALLOWED.*spec signoff.*--must/);
});

test('spec view emits JSON and refuses an unsupported flag before writing [S13, P4]', async (t) => {
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

test('spec unmet and signoff do not create a board when reading a repo without one [S14, P4]', async (t) => {
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

test('signoff refuses missing evidence atomically, and unmet shows every stage through a verified item [S14, S15, S16]', async (t) => {
  const box = specBox(t);
  const failed = await box.spec('signoff', 'G1', '--by', 'CO', '--note', 'I looked');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /NO_EVIDENCE.*G1.*build it or cite its id in a test first/);
  assert.equal(existsSync(join(box.root, SIGNOFFS_FILE)), false);
  assert.match((await box.spec('unmet')).stdout, /G1 \[must\].*— no evidence/);
  const added = await box.cmd('add', 'coordinator', 'Greeting', '--specs', 'G1');
  assert.equal(added.status, 0, added.stderr);
  assert.match((await box.spec('unmet')).stdout, /G1 \[must\].*— building/);
  assert.equal((await box.cmd('claim', '1')).status, 0);
  // A submit with no change against the claim head is refused (EMPTY_SUBMIT), so the claim gets a commit.
  writeFileSync(join(box.root, 'greeting.txt'), 'hello\n');
  box.git('add', 'greeting.txt'); box.git('commit', '-q', '-m', 'chore: add the greeting [G1]');
  const submitted = await box.cmd('submit', '1', '--wait', '--no-next');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match((await box.spec('unmet')).stdout, /G1 \[must\].*— awaiting a verdict/);
  const made = await box.cmd('worktree', 'review');
  assert.equal(made.status, 0, made.stderr);
  const review = /^made (.+) on branch/m.exec(made.stdout)[1];
  const acceptedNote = 'checked greeting in the private fixture\nsecond line stays in the receipt';
  const accepted = await runInProcessAt(box, review, ['verify', '1', 'accept', '--note', acceptedNote]);
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  assert.match((await box.spec('unmet')).stdout, /G1 \[must\].*— verified and ready to sign/);
  assert.equal(JSON.parse((await box.spec('unmet', '--json')).stdout).rows.find(row => row.id === 'G1').stage, 'verified and ready to sign');
  const signed = await box.spec('signoff', 'G1', '--by', 'CO', '--note', 'checked the accepting verdict');
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /verified #1: checked greeting in the private fixture/);
  assert.doesNotMatch(signed.stdout, /second line stays in the receipt/);
  assert.doesNotMatch((await box.spec('unmet')).stdout, /G1 \[must\]/);
  writeFileSync(join(box.root, box.specName), SPEC.replace('Same file twice is a no-op.', 'Same file twice stays a no-op.'));
  assert.match((await box.spec('unmet')).stdout, /G1 \[must\].*— stale/);
  assert.match((await box.spec('show', 'G1')).stdout, /checked the accepting verdict/);
});

test('a failing never-run test citation is not verified, and signoff says no tests were run [S15,S16]', async (t) => {
  const specSource = SPEC.replace('## K · Constraints', '- G3 [approved, must] A ghost test is only a citation. | gate: true\n\n## K · Constraints');
  const box = specBox(t, { specSource });
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/ghost.test.js'), '// [G3]\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL(".././ghost-ran", import.meta.url), "ran");\nthrow new Error("this ghost test fails if run");\n');
  box.git('add', 'test/ghost.test.js');
  box.git('commit', '-q', '-m', 'test: cite a never-run ghost');
  const unmet = await box.spec('unmet');
  assert.equal(unmet.status, 0, unmet.stderr);
  assert.match(unmet.stdout, /G3 \[must\].*— cited by tests, not verified/);
  const json = await box.spec('unmet', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).rows.find(row => row.id === 'G3').stage, 'cited by tests, not verified');
  assert.equal(existsSync(join(box.root, 'test/ghost-ran')), false, 'the citation scan never executes the failing test');
  const signed = await box.spec('signoff', 'G3', '--by', 'CO', '--note', 'the fixture person read the unverified citation');
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /cited by tests \(none run by pullboard\):\n    test\/ghost.test.js/);
  assert.doesNotMatch(signed.stdout, /verified #/);
  assert.equal(existsSync(join(box.root, 'test/ghost-ran')), false, 'signoff does not execute the test either');
  assert.ok(readSignoffs(box.root).some(row => row.id === 'G3'), 'S15 still permits the fixture person to sign');
});
