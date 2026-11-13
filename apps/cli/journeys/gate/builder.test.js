/** @pullboard-world-pin: clause 1 reads the four call-site sources to prove none builds the test command by hand. The command that runs named test files has one builder [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { affectedCommand } from '../../../../packages/gate/index.js';

const SITES = [
  'packages/gate/src/io/submit.js',
  'packages/gate/src/io/test/run.js',
  'packages/landing/src/io/deferred/run.js',
  'packages/landing/src/io/step/gate.js',
];

test('clause 1: affectedCommand quotes each file with the ./ prefix and trims the runner, the same string for the same input [C7]', () => {
  const files = ['test/a.test.js', "test/it's.test.js"];
  const expected = "node apps/cli/src/io/run/tests.js './test/a.test.js' './test/it'\\''s.test.js'";
  assert.equal(affectedCommand({ affectedTests: 'node apps/cli/src/io/run/tests.js' }, files), expected);
  assert.equal(affectedCommand({ affectedTests: 'node apps/cli/src/io/run/tests.js  ' }, files), expected, 'a trailing space in the config never changes the string');
});

test('clause 1: submit, proof reuse, landing and the deferred landing run build the command from affectedCommand alone [C7]', () => {
  for (const site of SITES) {
    const source = readFileSync(new URL(`../../../../${site}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /affectedTests\.trimEnd\(\)/u, `${site} assembles the test command by hand`);
    assert.doesNotMatch(source, /\.map\(\w+ => (?:quote|commandWord|shellWord)\('\.\/' \+/u, `${site} quotes test files by hand`);
    assert.match(source, /affected(?:Tests)?Command/u, `${site} calls the shared builder`);
  }
});
