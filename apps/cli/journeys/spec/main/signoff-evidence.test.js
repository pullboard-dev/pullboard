/** Sign-off evidence checks [S14,S15,S16]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSignoffs } from '../../../../../packages/spec/index.js';
import { SIGNOFFS_FILE } from '../../../../../packages/spec/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { SPEC } from '../../../tests/fixtures/spec/box.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';
import { runInProcessAt } from '../../../tests/fixtures/spec/box.js';

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
  const submitted = await box.cmd('submit', '1', '--no-next', '--json');
  assert.equal(submitted.status, 0, submitted.stderr);
  // A pulled submit returns queued; wait for the gate job's receipt so the item reads submitted, not building.
  const settleBox = { repo: box.root, env: box.env, run: async (cwd, ...args) => { const r = await box.cmd(...args); return { code: r.status, out: r.stdout, err: r.stderr }; } };
  await settleSubmit(t, settleBox, JSON.parse(submitted.stdout));
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
