/** @pullboard-test-input CHANGELOG.md docs/contributing-runbook.md */
/** Outside credits use the person's linked record format, without making acknowledgement compulsory [I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** Check each mentioned outside credit, including its matching link number and issue/PR kind. */
function validCredit(line) {
  if (!/\b(?:GitHub|PR)\s*#/u.test(line)) return true;
  const match = /\(#([1-9][0-9]*); (?:(reported in|requested in) \[GitHub #([1-9][0-9]*)\]|\[PR #([1-9][0-9]*)\])\(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/([1-9][0-9]*)\) by @([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\)$/u.exec(line);
  return Boolean(match && (match[3] ?? match[4]) === match[6]
    && match[5] === (match[4] ? 'pull' : 'issues')
    && [...line.matchAll(/\b(?:GitHub|PR)\s*#/gu)].length === 1);
}

test('outside changelog credits use the linked acknowledgement format [I1]', () => {
  const examples = [
    '(#1325; reported in [GitHub #10](https://github.com/pullboard-dev/pullboard/issues/10) by @McHersheys)',
    '(#1321; requested in [GitHub #7](https://github.com/pullboard-dev/pullboard/issues/7) by @Herklos)',
    '(#1330; [PR #9](https://github.com/pullboard-dev/pullboard/pull/9) by @McHersheys)',
  ];
  for (const example of examples) assert.equal(validCredit('- A change. ' + example), true, example);
  for (const invalid of [
    '- A change. GitHub #10 by @McHersheys',
    examples[0].replace('reported in ', ''),
    examples[0].replace('/issues/10', '/issues/11'),
    examples[0].replace('/issues/', '/pull/'),
    examples[2].replace('/pull/', '/issues/'),
    examples[1].replace(' by @Herklos', ''),
    examples[0] + ' Thank you!',
    'GitHub #11 ' + examples[0],
  ]) assert.equal(validCredit(invalid), false, invalid);
  assert.equal(validCredit('- An ordinary change. (#1317)'), true, 'uncredited entries remain valid');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  for (const [index, line] of changelog.split('\n').entries()) {
    assert.equal(validCredit(line), true, `CHANGELOG.md:${index + 1}: ${line}`);
  }
  const runbook = readFileSync(new URL('./contributing-runbook.md', import.meta.url), 'utf8');
  for (const example of examples) assert.ok(runbook.includes(example), `document the exact credit: ${example}`);
  for (const phrase of ["at the maintainer's discretion", 'a record, not a thank-you',
    'When an item with a handled reference ships', 'Syntax validation does not look up GitHub authors']) {
    assert.ok(runbook.includes(phrase), phrase);
  }
});
