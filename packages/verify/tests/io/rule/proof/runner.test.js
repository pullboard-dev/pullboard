/** @pullboard-test-input source-tree */
/** @pullboard-world-pin: clause 1 reads the shipped rule coverage source and the canonical runner launcher to prove their digest agrees. */
/** Verify names the canonical runner launcher by digest, because gate sits above it; the digest must track the file [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the canonical runner digest in rule coverage equals the launcher gate ships [C7]', () => {
  const coverage = readFileSync(new URL('../../../../src/io/rule/proof/coverage.js', import.meta.url), 'utf8');
  const declared = /const CANONICAL_RUNNER_DIGEST = '([0-9a-f]{64})'/u.exec(coverage)?.[1];
  const launcher = readFileSync(new URL('../../../../../gate/src/io/run/tests.js', import.meta.url));
  assert.equal(declared, createHash('sha256').update(launcher).digest('hex'),
    'set CANONICAL_RUNNER_DIGEST in packages/verify/src/io/rule/proof/coverage.js to the sha256 of packages/gate/src/io/run/tests.js');
});
