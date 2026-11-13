/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** Runner-only admission cases that drive the real CLI against a registered fixture runner, split from main.test.js to stay under its time budget [Q1,C7,V4,D1,D3]. */
import { installRunnerOnlyCases } from '../../../../packages/gate/tests/fixtures/resources/runner.js';
import { verificationProject } from '../../../../packages/gate/tests/fixtures/resources/verify.js';

installRunnerOnlyCases({ verificationProject });
