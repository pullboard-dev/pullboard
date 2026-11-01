/** Exact legacy namespace and binding identity survive the GitHub move [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const surfaces = [
  [
    "src/ci-flakes.js",
    "packages/github/src/shell/ci-flakes.js",
    [
      "ciObservations"
    ]
  ],
  [
    "src/intake-github.js",
    "packages/github/src/shell/intake-github.js",
    [
      "githubSource",
      "outsideURL"
    ]
  ],
  [
    "src/pr-findings.js",
    "packages/github/src/shell/pr-findings.js",
    [
      "recordPublishFinding"
    ]
  ],
  [
    "src/pr-github.js",
    "packages/github/src/shell/pr-github.js",
    [
      "githubPullClient",
      "githubRepository"
    ]
  ],
  [
    "src/pr-proof-graph.js",
    "packages/github/src/shell/pr-proof-graph.js",
    [
      "readProofGraph"
    ]
  ],
  [
    "src/pr-proof-snapshot.js",
    "packages/github/src/core/pr-proof-snapshot.js",
    [
      "capturePrProof"
    ]
  ],
  [
    "src/pr-publish.js",
    "packages/github/src/shell/pr-publish.js",
    [
      "publishPullRequests"
    ]
  ],
  [
    "src/pr-verification.js",
    "packages/github/src/shell/pr-verification.js",
    [
      "PR_VERIFICATION_CONTEXT",
      "publishVerificationStatuses",
      "pullRequestVerification",
      "verificationPulls"
    ]
  ],
  [
    "src/private-board.js",
    "packages/github/src/core/private-board.js",
    [
      "runPrivateBoard"
    ]
  ],
  [
    "src/publish.js",
    "packages/github/src/shell/publish.js",
    [
      "publishTrunk"
    ]
  ]
];

test('GitHub move preserves every legacy export name and exact provider binding [C7,CD60]', async () => {
  for (const [old, moved, names] of surfaces) {
    const legacy = await import('../' + old);
    const provider = await import('../' + moved);
    assert.deepEqual(Object.keys(legacy).sort(), names, old);
    assert.deepEqual(Object.keys(provider).sort(), names, moved);
    for (const name of names) assert.equal(legacy[name], provider[name], old + '#' + name);
  }
});

test('the broader GitHub barrel cannot masquerade as the CI observation module [C7,CD60]', async () => {
  const barrel = await import('../packages/github/index.js');
  assert.notDeepEqual(Object.keys(barrel).sort(), ['ciObservations']);
  assert.equal(typeof barrel.publishTrunk, 'function', 'the planted barrel route exposes an unrelated operation');
  const legacy = await import('../src/ci-flakes.js');
  assert.equal(Object.hasOwn(legacy, 'publishTrunk'), false, 'the compatibility entry never grants that operation');
});
