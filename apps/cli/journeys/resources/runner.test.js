/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** Runner-only admission cases that drive the real CLI against a registered fixture runner, split from main.test.js to stay under its time budget [Q1,C7,V4,D1,D3]. */
import { installRunnerOnlyCases } from '../../../../packages/gate/tests/fixtures/resources/runner.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { verificationProject as verify } from '../../../../packages/gate/tests/fixtures/resources/verify.js';

/** Bind the CLI app's e2e helpers to the gate fixture, which no longer imports apps. */
const verificationProject = (t, opts) => verify(t, opts, { helpers: createE2eHelpers() });

installRunnerOnlyCases({ verificationProject });
