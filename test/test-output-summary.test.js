/** @pullboard-test-loads src/commands/test.js */
/** @pullboard-test-loads src/commands/submit.js */
/** @pullboard-test-loads src/commands/verify.js */
/** Agent presentation keeps real test evidence in its full log instead of the context [C7,V10]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('an agent sees 200 passes and both failures in under 40 lines while the full output remains in its log [C7,V10]', () => {
  const box = e2e.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config,
    affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test', 'output.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "for (let n = 0; n < 200; n++) test(`passing case ${n}`, () => {});",
    "test('first failing case', () => assert.fail('first failure detail'));",
    "test('second failing case', () => assert.fail('second failure detail\\nadditional full-log detail'));",
    '',
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record real output-summary cases');
  // Only this private fixture child models an agent; no live identity or machine settings change.
  box.env.AI_AGENT = '1';
  const ran = box.run(box.repo, 'test', 'test/output.test.js');
  assert.equal(ran.code, 1, 'the two real assertions keep the command red');
  const output = [ran.out, ran.err].join('\n');
  assert.ok(output.trim().split('\n').length < 40,
    `agent output must be bounded, got ${output.trim().split('\n').length} lines`);
  assert.match(output, /200 pass(?:ed|es)?/iu);
  assert.match(output, /2 fail(?:ed|ures)?/iu);
  for (const name of ['first failing case', 'second failing case', 'first failure detail', 'second failure detail']) {
    assert.ok(output.includes(name), `summary retains ${name}`);
  }
  assert.match(output, /test\/output\.test\.js/u, 'each failure names its actual file');
  const log = /full (?:output )?log:\s*(.+)/iu.exec(output)?.[1]?.trim();
  assert.ok(log, 'the summary gives the durable full-log path');
  const full = readFileSync(log, 'utf8');
  assert.match(full, /passing case 199/u);
  assert.match(full, /additional full-log detail/u);
  assert.match(full, /# tests 202/u);
  assert.match(full, /# pass 200/u);
  assert.match(full, /# fail 2/u);
  const json = box.run(box.repo, 'test', 'test/output.test.js', '--json');
  assert.equal(json.code, 1);
  const result = JSON.parse(json.out);
  assert.deepEqual(result.counts, { passed: 200, failed: 2, skipped: 0 });
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every(row => row.file === 'test/output.test.js'));
  assert.doesNotMatch(json.out, /# Subtest:|passing case 199/u, 'JSON keeps a summary instead of the complete TAP');
  assert.match(readFileSync(result.logPath, 'utf8'), /passing case 199/u);
});

/** Build real private submit/verify inputs; the external flag changes runtime data, never frozen source. */
function itemProject() {
  const box = e2e.project('true');
  const flag = join(box.dir, 'fail-tests');
  const command = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/output.test.js';
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')),
    gate: command, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test', 'output.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { existsSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `const red = existsSync(${JSON.stringify(flag)});`,
    "for (let n = 0; n < 200; n++) test(`passing case ${n}`, () => {});",
    "test('first failing case', () => assert.ok(!red, 'first failure detail'));",
    "test('second failing case', () => assert.ok(!red, 'second failure detail'));",
    '',
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record native item-check inputs');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Output fixture', '--specs', 'G1',
    '--criterion', 'the recorded test file runs', '--check', command);
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  return { box, flag };
}

/** Keep the real refusal and both diagnostics while reading its full native output artifact. */
function assertFailureSummary(result, code) {
  assert.equal(result.code, 1);
  const text = [result.out, result.err].join('\n');
  assert.ok(text.trim().split('\n').length < 40, `${code} output is bounded`);
  assert.match(text, new RegExp(code));
  for (const value of ['first failing case', 'second failing case', 'first failure detail', 'second failure detail']) {
    assert.ok(text.includes(value), `${code} retains ${value}`);
  }
  const path = /full log:\s*(.+)/iu.exec(text)?.[1]?.trim();
  assert.ok(path, `${code} names its complete native log`);
  assert.match(readFileSync(path, 'utf8'), /passing case 199/u);
}

test('a red native submit keeps its authority refusal and prints both cases instead of full TAP [C7,V4,V10]', () => {
  const { box, flag } = itemProject();
  writeFileSync(flag, 'red');
  assertFailureSummary(box.run(box.web, 'submit', '1', '--no-next'), 'GATE_RED');
  const item = JSON.parse(box.run(box.repo, 'show', '1', '--json').out);
  assert.equal(item.item_status, 'claimed', 'presentation never turns a red proof into a submission');
});

test('native submit JSON and a red frozen verification expose bounded cases and complete logs [C7,V4,V10]', () => {
  const { box, flag } = itemProject();
  const submitted = box.run(box.web, 'submit', '1', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err);
  const document = JSON.parse(submitted.out);
  assert.ok(document.gate.counts.passed >= 202);
  assert.equal(document.gate.counts.failed, 0);
  assert.equal(document.gate.profile.tests, undefined, 'case-level records stay in the full timing profile');
  assert.match(readFileSync(document.gate.logPath, 'utf8'), /passing case 199/u);
  const review = join(box.dir, 'review-output');
  box.git(box.repo, 'worktree', 'add', '-q', review, '-b', 'review/output');
  const joined = box.run(review, 'join', 'review', '--model', 'Test Model');
  assert.equal(joined.code, 0, joined.err);
  writeFileSync(flag, 'red');
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'run the frozen assertions', '--no-next');
  assertFailureSummary(refused, 'CHECK_RED');
  const json = box.run(review, 'verify', '1', 'accept', '--note', 'run the same frozen assertions', '--no-next', '--json');
  assert.equal(json.code, 1);
  const failure = JSON.parse(json.out);
  assert.equal(failure.error.code, 'CHECK_RED');
  assert.deepEqual(failure.counts, { passed: 200, failed: 2, skipped: 0 });
  assert.equal(failure.failures.length, 2);
  assert.match(readFileSync(failure.logPath, 'utf8'), /passing case 199/u);
  const item = JSON.parse(box.run(box.repo, 'show', '1', '--json').out);
  assert.equal(item.item_status, 'submitted', 'a failed frozen check still cannot accept the item');
  assert.equal(item.verdicts.length, 0);
});
