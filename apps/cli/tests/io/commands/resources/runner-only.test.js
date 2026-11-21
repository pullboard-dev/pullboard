/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** Runner-only admission and doctrine cases that drive the real CLI against a registered fixture runner [Q1,C7,V4,D1,D3]. */
import { installRunnerOnlyUncountedCase } from '../../../../../../packages/gate/tests/fixtures/resources/runner.js';
import { registerStandInAfterAdd } from '../../../fixtures/runner/registered.js';
import { serveRegisteredRunner } from '../../../fixtures/runner/registered.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { settledGateJob } from '../../../fixtures/submit/settle.js';
import { installRunnerOnlyDoctrineCase } from '../../../../../../packages/gate/tests/fixtures/resources/runner.js';
import { installRunnerOnlyOrdinaryCase } from '../../../../../../packages/gate/tests/fixtures/resources/runner.js';
import { HOST } from '../../../fixtures/runner/ssh.js';
import { installRunnerOnlyCases } from '../../../../../../packages/gate/tests/fixtures/resources/runner.js';
import { verificationProject as verify } from '../../../../../../packages/gate/tests/fixtures/resources/verify.js';

installRunnerOnlyUncountedCase({ helpers: createE2eHelpers(), registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });

installRunnerOnlyDoctrineCase({ helpers: createE2eHelpers(), registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });

installRunnerOnlyOrdinaryCase({ helpers: createE2eHelpers(), HOST, registerStandInAfterAdd, serveRegisteredRunner, settledGateJob });

/** Bind the CLI app's e2e helpers to the gate fixture, which no longer imports apps. */
const verificationProject = (t, opts) => verify(t, opts, { helpers: createE2eHelpers() });

installRunnerOnlyCases({ verificationProject });
