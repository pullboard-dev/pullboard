/** @pullboard-test-input source-cell apps/cli */
/** The cells inventory cache serves a stored main report exactly as stored [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { inventoryCache } from '../../../src/io/cells/cache.js';

test('cli.io-cells-cache.stored-report-served-unchanged: clause 1: the report method returns the stored main report byte-identical, temporary shim finding included [C7]', () => {
  const fixture = privateFixtureFiles('cells-cache-');
  const root = fixture.root;
  {
    fixture.write('a.txt', 'a\n');
    fixtureCommitAll(root);
    const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
    const tree = runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: root });
    const finding = { key: 'temporary:a->b', count: 1, detail: 'contract #1; expires 2099-01-01 UTC' };
    const report = {
      metrics: { shims: { count: 1, findings: [finding] }, unknown: { count: 0, findings: [] } },
      unknown: [],
    };
    const before = JSON.stringify(report);
    const artifact = { available: true, descriptor: { tree }, inventory: { files: new Map(), edges: new Map(), unknown: [] }, report };
    const cache = inventoryCache(root, null, [], () => {}, () => true, { artifact, strict: true });
    const served = cache.report(root, commit);
    assert.equal(served, report, 'the stored report itself comes back');
    assert.equal(JSON.stringify(served), before, 'the stored report is byte-identical');
    assert.deepEqual(served.metrics.shims.findings, [finding], 'the temporary shim finding is neither dropped nor recomputed');
  }
});
