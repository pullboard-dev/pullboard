/** A baseline that could not run keeps the refusal that stopped it, and show prints it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../../kernel/index.js';
import { sayCheckBaseline } from '../../../../src/logic/format.js';
import { unavailableBaseline } from '../../../../src/io/check/baseline/worker.js';

const EXPECTED = { command: 'node packages/gate/src/io/run/tests.js test/a.test.js', main: 'a'.repeat(40) };

test('gate.io-check-baseline-unavailable.a-thrown-refusal-records-unavailable-with: clause 1: a thrown refusal records unavailable with its code and first message line [C7]', () => {
  const error = new Refused('RUNNER_TOOLING_FILES', 'the runner source carries tooling files: .pullboard-runner-source.json\nsecond line stays out');
  const baseline = unavailableBaseline(EXPECTED, error);
  assert.equal(baseline.result, 'unavailable');
  assert.equal(baseline.command, EXPECTED.command);
  assert.equal(baseline.main, EXPECTED.main);
  assert.match(baseline.reason, /RUNNER_TOOLING_FILES: the runner source carries tooling files: \.pullboard-runner-source\.json;/u);
  assert.doesNotMatch(baseline.reason, /second line/u);
});

test('gate.io-check-baseline-unavailable.a-plain-error-keeps-its-first: clause 1: a plain error keeps its first line and a non-error still names a cause [C7]', () => {
  assert.match(unavailableBaseline(EXPECTED, new Error('spawn ENOENT\nstack')).reason, /could not run: spawn ENOENT;/u);
  assert.match(unavailableBaseline(EXPECTED, undefined).reason, /could not run: unknown error;/u);
});

test('gate.io-check-baseline-unavailable.pullboard-show-prints-the-recorded-refusal: clause 1: pullboard show prints the recorded refusal code and message [C7]', () => {
  const said = [];
  const baseline = unavailableBaseline(EXPECTED, new Refused('RUNNER_TOOLING_FILES', 'tooling file in the source'));
  sayCheckBaseline({ say: line => said.push(line) }, { item_id: 7, item_check_baseline: baseline });
  assert.deepEqual(said, ['check baseline unavailable: background check could not run: RUNNER_TOOLING_FILES: tooling file in the source; set --check again from the coordinator']);
});
