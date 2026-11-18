/** The static stage prints a keyless finding (path: text, no line) rather than hiding it in overhead lines [C7,#9275]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStaticStage } from '../../../src/io/static/stage.js';

/** A stage command that prints the given lines and exits with the given status, through the real shell. */
const printing = (lines, status) => `printf '%s\\n' ${lines.map(line => `'${line}'`).join(' ')}; exit ${status}`;

/** Run the stage with a recording output channel. */
function stage(command) {
  const said = [];
  const results = [];
  const code = runStaticStage({ say: text => said.push(text), result: row => results.push(row) }, process.cwd(), { command });
  return { code, said, results };
}

const KEYLESS = 'keyless:packages/runners/tests/fixtures/trusted-tooling.js: non-literal dynamic import';
const KEYED = 'packages/api/tests/io/ledger.test.js:8: new test finding exceeds the ratchet';

test('cli.io-static-keyless.a-keyless-row-prints-as-static-red: clause 1: a keyless row prints as STATIC_RED path: text and the no-finding line is gone [C7]', () => {
  const { code, said, results } = stage(printing(['TRIP_OVERHEAD report line', KEYLESS], 1));
  assert.equal(code, 1);
  assert.deepEqual(said, ['STATIC_RED packages/runners/tests/fixtures/trusted-tooling.js: non-literal dynamic import']);
  assert.equal(results[0].findings[0].line, null);
  assert.doesNotMatch(said.join('\n'), /no file:line finding/u);
});

test('cli.io-static-keyless.file-line-rows-still-print-as-before: clause 2: file:line rows still print as before beside a keyless row [C7]', () => {
  const { said } = stage(printing([KEYED, KEYLESS], 1));
  assert.deepEqual(said, [`STATIC_RED ${KEYED}`, 'STATIC_RED packages/runners/tests/fixtures/trusted-tooling.js: non-literal dynamic import']);
});

test('cli.io-static-keyless.a-failing-stage-with-no-finding-row: clause 3: a failing stage with no finding row still prints the no-finding line [C7]', () => {
  const { code, said } = stage(printing(['TRIP_OVERHEAD report line only'], 1));
  assert.equal(code, 1);
  assert.match(said.join('\n'), /failed with no file:line finding/u);
});
