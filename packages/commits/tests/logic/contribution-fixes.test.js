/** @pullboard-world-pin reads the parser and clause runner source to list every refusal code. Each contribution record failure maps to a rule, a fix and a skill command; an unmapped code fails [CR5]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONTRIBUTION_FIXES } from '../../src/logic/contribution.js';
import { contributionFix } from '../../src/logic/contribution.js';

const SOURCES = ['../../src/logic/contribution.js', '../../src/logic/contribution-clauses.js', '../../src/io/contribution-clauses.js'];

/** Every refusal code the parser and the clause runner can return, read from their source. */
function refusalCodes() {
  const codes = new Set();
  for (const file of SOURCES) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const match of text.matchAll(/(?:refuse|Refused)\(\s*'([A-Z][A-Z_0-9]+)'/gu)) codes.add(match[1]);
  }
  return codes;
}

test('commits.logic-contribution-fixes.every-refusal-code-of-the-parser-and-the: [CR5] every refusal code of the parser and the clause runner maps to a rule, a fix line and a skill command', () => {
  const codes = refusalCodes();
  assert.ok(codes.size >= 30, `found ${codes.size} codes`);
  for (const code of codes) {
    const row = contributionFix(code);
    assert.ok(row, `${code} has no row in contribution.js; add its rule, fix and command`);
    for (const key of ['rule', 'fix', 'command']) assert.equal(typeof row[key], 'string', `${code} ${key}`);
    assert.ok(row.rule && row.fix && row.command.startsWith('pullboard '), code);
  }
});

test('commits.logic-contribution-fixes.a-failure-with-no-mapping-is-not-found: [CR5] a failure with no mapping is not found, and a row for a code nothing raises fails the test', () => {
  assert.equal(contributionFix('CONTRIB_NEW_RULE'), null);
  assert.equal(contributionFix('toString'), null);
  const codes = refusalCodes();
  for (const code of Object.keys(CONTRIBUTION_FIXES)) assert.ok(codes.has(code), `${code} is mapped but no refusal raises it`);
});
