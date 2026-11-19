/** GitHub front-door bindings preserve each moved provider [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as barrel from '../../index.js';
import * as provider0 from '../../src/io/flakes.js';
import * as provider1 from '../../src/io/intake.js';
import * as provider2 from '../../src/io/pr/findings.js';
import * as provider3 from '../../src/io/pr.js';
import * as provider5 from '../../src/logic/snapshot.js';
import * as provider7 from '../../src/io/pr/verification.js';
import * as provider8 from '../../src/logic/private.js';
import * as provider9 from '../../src/io/publish.js';

const surfaces = [
  ["src/ci-flakes.js", "packages/github/src/shell/ci-flakes.js", ["ciObservations"], provider0],
  ["src/intake-github.js", "packages/github/src/shell/intake-github.js", ["githubSource", "outsideURL"], provider1],
  ["src/pr-findings.js", "packages/github/src/shell/pr-findings.js", ["recordPublishFinding"], provider2],
  ["src/pr-github.js", "packages/github/src/shell/pr-github.js", ["githubPullClient", "githubRepository"], provider3],
  ["src/pr-proof-snapshot.js", "packages/github/src/core/pr-proof-snapshot.js", ["capturePrProof"], provider5],
  ["src/pr-verification.js", "packages/github/src/shell/pr-verification.js", ["PR_VERIFICATION_CONTEXT", "publishVerificationStatuses", "pullRequestVerification", "verificationPulls"], provider7],
  ["src/private-board.js", "packages/github/src/core/private-board.js", ["runPrivateBoard"], provider8],
  ["src/publish.js", "packages/github/src/shell/publish.js", ["publishTrunk"], provider9]
];

test('github.snapshot.provider-bindings: GitHub front door preserves every exact provider binding [C7,CD60]', async () => {
  for (const [old, moved, names, provider] of surfaces) {
    assert.deepEqual(Object.keys(provider).sort(), names, moved);
    for (const name of names) assert.equal(barrel[name], provider[name], old + '#' + name);
  }
});

test('github.snapshot.barrel-not-ci-module: the broader GitHub barrel cannot masquerade as the CI observation module [C7,CD60]', async () => {
  assert.notDeepEqual(Object.keys(barrel).sort(), ['ciObservations']);
  assert.equal(typeof barrel.publishTrunk, 'function', 'the planted barrel route exposes an unrelated operation');
  assert.equal(Object.hasOwn(provider0, 'publishTrunk'), false, 'the CI provider never grants that operation');
});
