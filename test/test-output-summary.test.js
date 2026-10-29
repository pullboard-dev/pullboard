/** @pullboard-test-loads src/commands/test.js */
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
});
