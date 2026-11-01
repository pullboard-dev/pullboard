/** Exact legacy namespace and binding identity survive the GitHub move [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as barrel from '../packages/github/index.js';
import * as legacy0 from '../src/ci-flakes.js';
import * as provider0 from '../packages/github/src/shell/ci-flakes.js';
import * as legacy1 from '../src/intake-github.js';
import * as provider1 from '../packages/github/src/shell/intake-github.js';
import * as legacy2 from '../src/pr-findings.js';
import * as provider2 from '../packages/github/src/shell/pr-findings.js';
import * as legacy3 from '../src/pr-github.js';
import * as provider3 from '../packages/github/src/shell/pr-github.js';
import * as legacy4 from '../src/pr-proof-graph.js';
import * as provider4 from '../packages/github/src/shell/pr-proof-graph.js';
import * as legacy5 from '../src/pr-proof-snapshot.js';
import * as provider5 from '../packages/github/src/core/pr-proof-snapshot.js';
import * as legacy6 from '../src/pr-publish.js';
import * as provider6 from '../packages/github/src/shell/pr-publish.js';
import * as legacy7 from '../src/pr-verification.js';
import * as provider7 from '../packages/github/src/shell/pr-verification.js';
import * as legacy8 from '../src/private-board.js';
import * as provider8 from '../packages/github/src/core/private-board.js';
import * as legacy9 from '../src/publish.js';
import * as provider9 from '../packages/github/src/shell/publish.js';

const surfaces = [
  ["src/ci-flakes.js", "packages/github/src/shell/ci-flakes.js", ["ciObservations"], legacy0, provider0],
  ["src/intake-github.js", "packages/github/src/shell/intake-github.js", ["githubSource", "outsideURL"], legacy1, provider1],
  ["src/pr-findings.js", "packages/github/src/shell/pr-findings.js", ["recordPublishFinding"], legacy2, provider2],
  ["src/pr-github.js", "packages/github/src/shell/pr-github.js", ["githubPullClient", "githubRepository"], legacy3, provider3],
  ["src/pr-proof-graph.js", "packages/github/src/shell/pr-proof-graph.js", ["readProofGraph"], legacy4, provider4],
  ["src/pr-proof-snapshot.js", "packages/github/src/core/pr-proof-snapshot.js", ["capturePrProof"], legacy5, provider5],
  ["src/pr-publish.js", "packages/github/src/shell/pr-publish.js", ["publishPullRequests"], legacy6, provider6],
  ["src/pr-verification.js", "packages/github/src/shell/pr-verification.js", ["PR_VERIFICATION_CONTEXT", "publishVerificationStatuses", "pullRequestVerification", "verificationPulls"], legacy7, provider7],
  ["src/private-board.js", "packages/github/src/core/private-board.js", ["runPrivateBoard"], legacy8, provider8],
  ["src/publish.js", "packages/github/src/shell/publish.js", ["publishTrunk"], legacy9, provider9]
];

test('GitHub move preserves every legacy export name and exact provider binding [C7,CD60]', async () => {
  for (const [old, moved, names, legacy, provider] of surfaces) {
    assert.deepEqual(Object.keys(legacy).sort(), names, old);
    assert.deepEqual(Object.keys(provider).sort(), names, moved);
    for (const name of names) assert.equal(legacy[name], provider[name], old + '#' + name);
  }
});

test('the broader GitHub barrel cannot masquerade as the CI observation module [C7,CD60]', async () => {
  assert.notDeepEqual(Object.keys(barrel).sort(), ['ciObservations']);
  assert.equal(typeof barrel.publishTrunk, 'function', 'the planted barrel route exposes an unrelated operation');
  assert.equal(Object.hasOwn(legacy0, 'publishTrunk'), false, 'the compatibility entry never grants that operation');
});
