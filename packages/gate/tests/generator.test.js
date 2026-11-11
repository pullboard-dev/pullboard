/** @pullboard-test-input source-tree */
/** Generator execution must retain its guards in the lifecycle audit's source model [M1,M4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { functionsIn } from './fixtures/functions.js';

test('generator shell plans retain their real refusal bodies in the lifecycle audit [M1,M4,C7]', () => {
  const source = readFileSync(new URL('../src/io/run/shell.js', import.meta.url), 'utf8');
  const body = functionsIn(source).get('shellExecution');
  assert.ok(body, 'the shared generator is a reachable named function');
  for (const code of ['PIPEFAIL_UNAVAILABLE', 'LAND_TIMEOUT_CUSTODY', 'LAND_GATE_OUTPUT']) {
    assert.ok(body.includes(`new Refused('${code}'`), `${code} remains in its actual function body`);
  }
});

test('the lifecycle source model recognizes synchronous and asynchronous generator declarations [M1,M4,C7]', () => {
  for (const declaration of ['function*', 'async function*', 'export function*', 'export async function*']) {
    const source = `${declaration} execution() {\n  yield command;\n  throw new Refused('GENERATOR_PROBE', 'must remain audited');\n}\n`;
    const functions = functionsIn(source);
    assert.deepEqual([...functions.keys()], ['execution']);
    assert.match(functions.get('execution'), /throw new Refused\('GENERATOR_PROBE'/u);
  }
});
