/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads apps/cli/src/io/commands/submit.js */
/** @pullboard-test-loads apps/cli/src/io/commands/verify.js */
/** Agent presentation keeps real test evidence in its full log instead of the context [C7,V10]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 1: an agent sees 200 passes and both failures in under 40 lines while the full output remains in its log [C7,V10]', async () => {
  const box = e2e.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config,
    affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/output.test.js'), [
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
  const ran = await box.runLocal(box.repo, 'test', 'test/output.test.js');
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
  const json = await box.runLocal(box.repo, 'test', 'test/output.test.js', '--json');
  assert.equal(json.code, 1);
  const result = JSON.parse(json.out);
  assert.deepEqual(result.counts, { passed: 200, failed: 2, skipped: 0 });
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every(row => row.file === 'test/output.test.js'));
  assert.doesNotMatch(json.out, /# Subtest:|passing case 199/u, 'JSON keeps a summary instead of the complete TAP');
  assert.match(readFileSync(result.logPath, 'utf8'), /passing case 199/u);
});

/** Build real private submit/verify inputs; the external flag changes runtime data, never frozen source. */
async function itemProject() {
  const box = e2e.project('true');
  const flag = join(box.dir, 'fail-tests');
  const command = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/output.test.js';
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.web.owns.push('test/');
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { ...config.submit, handoff: false },
    gate: command, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/output.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { existsSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `const red = existsSync(${JSON.stringify(flag)}) && existsSync(new URL('../web/output-summary-candidate.js', import.meta.url));`,
    "for (let n = 0; n < 200; n++) test(`passing case ${n}`, () => {});",
    "test('first failing case', () => assert.ok(!red, 'first failure detail'));",
    "test('second failing case', () => assert.ok(!red, 'second failure detail'));",
    '',
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record native item-check inputs');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Output fixture', '--specs', 'G1',
    '--criterion', 'the recorded test file runs', '--check', command);
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'output-summary-candidate.js'), 'export const candidate = true;\n');
  box.git(box.web, 'add', 'web/output-summary-candidate.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add output summary candidate [G1]');
  const submittedHead = box.git(box.web, 'rev-parse', 'HEAD').trim();
  return { box, flag, submittedHead };
}

/** Keep the real refusal and both diagnostics while reading its full native output artifact. */
function assertFailureSummary(result, code) {
  assert.equal(result.code, 1);
  const text = [result.out, result.err].join('\n');
  if (code === 'CHECK_RED') {
    const marker = 'last output lines (up to 40):';
    const start = text.indexOf(marker);
    const end = text.indexOf('\nfull output file:', start);
    assert.ok(start >= 0 && end > start, 'CHECK_RED includes its bounded output tail and full-log pointer');
    const tail = text.slice(start + marker.length, end).trim();
    const tailLines = tail ? tail.split('\n').length : 0;
    assert.ok(tailLines <= 40, `CHECK_RED tail is bounded to 40 lines, got ${tailLines}`);
    const remaining = text.slice(0, start) + text.slice(end + 1);
    assert.ok(remaining.trim().split('\n').length < 40, 'CHECK_RED digest and wrapper are bounded apart from its tail');
  } else {
    const lineCount = text.trim().split('\n').length;
    assert.ok(lineCount < 40, `${code} output is bounded (${lineCount} lines)`);
  }
  assert.match(text, new RegExp(code));
  for (const value of ['first failing case', 'second failing case', 'first failure detail', 'second failure detail']) {
    assert.ok(text.includes(value), `${code} retains ${value}`);
  }
  const path = /full log:\s*(.+)/iu.exec(text)?.[1]?.trim();
  assert.ok(path, `${code} names its complete native log`);
  assert.match(readFileSync(path, 'utf8'), /passing case 199/u);
}

test('a red native submit keeps its authority refusal and prints both cases instead of full TAP [C7,V4,V10]', async () => {
  const { box, flag } = await itemProject();
  writeFileSync(flag, 'red');
  assertFailureSummary(await box.runLocal(box.web, 'submit', '1', '--no-next'), 'GATE_RED');
  const item = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'claimed', 'presentation never turns a red proof into a submission');
});

test('native submit JSON and a red frozen verification expose bounded cases and complete logs [C7,V4,V10]', async () => {
  const { box, flag, submittedHead } = await itemProject();
  const submitted = await box.runLocal(box.web, 'submit', '1', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err);
  const document = JSON.parse(submitted.out);
  assert.ok(document.gate.counts.passed >= 202);
  assert.equal(document.gate.counts.failed, 0);
  assert.equal(document.gate.profile.tests, undefined, 'case-level records stay in the full timing profile');
  assert.match(readFileSync(document.gate.logPath, 'utf8'), /passing case 199/u);
  const review = join(box.dir, 'review-output');
  // Advance an actual checked input so the frozen check runs instead of reusing the submit proof.
  appendFileSync(join(box.repo, 'test/output.test.js'), '\n// Advance the checked input on main.\n');
  box.git(box.repo, 'add', 'test/output.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: advance checked fixture input');
  box.git(box.repo, 'worktree', 'add', '-q', review, '-b', 'review/output', submittedHead);
  const joined = fixtureJoin(box.run, review, 'api', '--model', 'Test Model');
  assert.equal(joined.code, 0, joined.err);
  writeFileSync(flag, 'red');
  const refused = await box.runLocal(review, 'verify', '1', 'accept', '--note', 'run the frozen assertions', '--no-next');
  assertFailureSummary(refused, 'CHECK_RED');
  const json = await box.runLocal(review, 'verify', '1', 'accept', '--note', 'run the same frozen assertions', '--no-next', '--json');
  assert.equal(json.code, 1);
  const failure = JSON.parse(json.out);
  assert.equal(failure.error.code, 'CHECK_RED');
  assert.deepEqual(failure.counts, { passed: 200, failed: 2, skipped: 0 });
  assert.equal(failure.failures.length, 2);
  assert.match(readFileSync(failure.logPath, 'utf8'), /passing case 199/u);
  const item = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'submitted', 'a failed frozen check still cannot accept the item');
  assert.equal(item.verdicts.length, 0);
});
