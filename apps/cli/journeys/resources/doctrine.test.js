/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** The runner-only doctrine count case against a registered fixture runner, split from runner.test.js to stay under its time budget [Q1,C7,D1,D3]. */
import { installRunnerOnlyDoctrineCase } from '../../../../packages/gate/tests/fixtures/resources/runner.js';

installRunnerOnlyDoctrineCase();
