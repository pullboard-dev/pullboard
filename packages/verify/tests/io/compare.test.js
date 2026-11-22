/** Empty test selection remains distinct from missing project or gate test coverage [V4,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { compareVerification } from '../../src/io/compare.js';

/** Return deterministic Git answers for a comparison source without building a scratch repository. */
function gitReader({ head, base, commonDir, headFiles = [], baseFiles = [] }) {
  return (_root, args) => {
    if (args[0] === 'rev-parse' && args[1] === `${head}^{commit}`) return head;
    if (args[0] === 'merge-base') return base;
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return commonDir;
    if (args[0] === 'ls-tree') {
      const files = args[2] === head ? headFiles : baseFiles;
      return files.map(file => `100644 blob ${'c'.repeat(40)}\t${file}`).join('\0') + (files.length ? '\0' : '');
    }
    throw new Error(`unexpected Git read: ${args.join(' ')}`);
  };
}

test('verify.io-compare.empty-selection: clause 1: empty head and base selection records no comparison execution and no invented case result [V4,C7]', async (t) => {
  const fixture = privateFixtureFiles('pullboard-verify-compare-empty-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const head = 'a'.repeat(40), base = head;
  let runs = 0;
  const result = await compareVerification(fixture.root, { item_id: 12898, item_commit: head, item_frozen_digest: 'a'.repeat(64) }, {
    main: base,
    selectTests: async () => ({ files: [] }),
    runTests: async () => { runs++; throw new Error('empty selection must not start a runner'); },
    runnerAvailable: () => false,
    gitRead: gitReader({ head, base, commonDir: fixture.root }),
  });
  assert.equal(runs, 0);
  assert.equal(result.head.id, null);
  assert.equal(result.base.id, null);
  assert.equal(result.head.skipped, 'no selected comparison execution');
  assert.equal(result.base.skipped, 'no selected comparison execution');
  assert.equal(result.newRed, null);
  assert.equal(result.fixed, null);
});

test('verify.io-compare.empty-base: clause 2: a selected new test with no base file retains the head run but does not claim a case comparison [V4,C7]', async (t) => {
  const fixture = privateFixtureFiles('pullboard-verify-compare-base-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const head = 'b'.repeat(40), base = 'a'.repeat(40);
  const runId = '11111111-1111-4111-8111-111111111111';
  let runs = 0;
  const result = await compareVerification(fixture.root, { item_id: 12898, item_commit: head, item_frozen_digest: 'b'.repeat(64) }, {
    main: base,
    selectTests: async () => ({ files: ['new.test.js'] }),
    runTests: async (commit, files) => {
      runs++;
      assert.equal(commit, head);
      assert.deepEqual(files, ['new.test.js']);
      return { id: runId, isGreen: true,
        testOutcomes: [{ file: 'new.test.js', name: 'clause 2: new case', passed: true, skipped: false }] };
    },
    runnerAvailable: () => true,
    gitRead: gitReader({ head, base, commonDir: fixture.root, headFiles: ['new.test.js'] }),
  });
  assert.equal(runs, 1);
  assert.equal(result.head.id, runId);
  assert.equal(result.base.id, null);
  assert.equal(result.base.skipped, 'no selected comparison execution');
  assert.equal(result.newRed, null);
  assert.equal(result.fixed, null);
});
