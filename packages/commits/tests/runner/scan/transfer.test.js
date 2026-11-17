import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretsIn } from '../../../index.js';

test('commits.runner-scan-transfer.a-large-clean-batch-of-kebab-case-names: a large clean batch of kebab-case names and source text is never refused as a key [C7,S1]', () => {
  const names = Array.from({ length: 600 }, (_, index) => ({
    path: `test/risk-management-policy-sheet-${index}-configuration.test.js`, line: 1,
    text: `risk-management-policy-sheet-${index}-configuration-task-runner.test.js`,
  }));
  const source = Array.from({ length: 600 }, (_, index) => ({
    path: `test/fixture-${index}.js`, line: 2,
    // Joined at run time so older scanners reading this source never see a long key-shaped literal.
    text: `const queue = '${['desk', 'scheduler-backed-queue-configuration', index].join('-')}';`,
  }));
  assert.deepEqual(secretsIn([...names, ...source]), []);
});

test('commits.runner-scan-transfer.a-planted-openai-or-anthropic-key-is: a planted OpenAI or Anthropic key is still refused by name in transferred source [C7,S1]', () => {
  // Assembled at run time so this source file holds no key-shaped literal for the commit scan to refuse.
  const openai = ['sk-proj', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('-');
  const anthropic = ['sk-ant', 'api03-abcdefghijklmnopqrstuvwxyz0123'].join('-');
  const findings = secretsIn([
    { path: 'src/config.js', line: 4, text: `const key = "${openai}";` },
    { path: 'src/client.js', line: 9, text: `token ${anthropic}` },
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /^OpenAI key at src\/config\.js:4$/u);
  assert.match(findings[1], /^Anthropic key at src\/client\.js:9$/u);
});

test('commits.runner-scan-transfer.legacy-and-none-prefixed-openai-key: legacy and None-prefixed OpenAI key shapes are still refused by name [C7,S1]', () => {
  // Assembled at run time: the 'None' shape and a legacy key with an underscore in its first 32 characters.
  const none = ['sk-None', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL'].join('-');
  const legacyUnderscore = ['sk', 'abcdef_ghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL'].join('-');
  const findings = secretsIn([
    { path: 'src/none.js', line: 1, text: `const k = "${none}";` },
    { path: 'src/legacy.js', line: 2, text: `const k = "${legacyUnderscore}";` },
  ]);
  assert.deepEqual(findings, ['OpenAI key at src/none.js:1', 'OpenAI key at src/legacy.js:2']);
});
