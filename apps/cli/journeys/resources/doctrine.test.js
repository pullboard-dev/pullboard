/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** The runner-only doctrine rising-count refusal against a registered fixture runner, split from runner.test.js and doctrine-uncounted.test.js to stay under its time budget [Q1,C7,D1,D3]. */
import { installRunnerOnlyDoctrineCase } from '../../../../packages/gate/tests/fixtures/resources/runner.js';
import { registerStandInAfterAdd } from '../../tests/fixtures/runner/registered.js';
import { serveRegisteredRunner } from '../../tests/fixtures/runner/registered.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

installRunnerOnlyDoctrineCase({ helpers: createE2eHelpers(), registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });
