/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** The runner-only uncountable and final green doctrine submits against a registered fixture runner, split from doctrine.test.js to stay under its time budget [Q1,C7,D1,D3]. */
import { installRunnerOnlyUncountedCase } from '../../../../packages/gate/tests/fixtures/resources/runner.js';
import { registerStandInAfterAdd } from '../../tests/fixtures/runner/registered.js';
import { serveRegisteredRunner } from '../../tests/fixtures/runner/registered.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

installRunnerOnlyUncountedCase({ registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });
