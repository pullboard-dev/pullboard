/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** The runner-only ordinary doctrine submission against a registered fixture runner, split from doctrine-uncounted.test.js to stay under its time budget [Q1,C7,D1,D3]. */
import { installRunnerOnlyOrdinaryCase } from '../../../../../packages/gate/tests/fixtures/resources/runner.js';
import { registerStandInAfterAdd } from '../../../tests/fixtures/runner/registered.js';
import { serveRegisteredRunner } from '../../../tests/fixtures/runner/registered.js';
import { settledGateJob } from '../../../tests/fixtures/submit/settle.js';

installRunnerOnlyOrdinaryCase({ registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });
