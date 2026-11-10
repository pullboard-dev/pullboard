/** A blocked automatic landing cannot withdraw unrelated accepted verdicts [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { after } from 'node:test';
import { join } from 'node:path';
import { landAcceptedItems } from '../../../../../packages/merge/index.js';
import {
  bisect,
  landingBaseGreen,
} from '../../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('automatic landing leaves withdrawal to the culprit identified by bisection [B3,C7]', async () => {
  const reopened = [];
  const reopen = async id => reopened.push(id);
  const result = await landAcceptedItems({ root: '.', config: {}, trunk: 'unused', items: [], reopen,
    execute: async () => {
      await reopen(2); // The landing engine has already returned its independently bisected culprit.
      return { batch: { state: 'blocked', items: [{ id: 1 }, { id: 2 }, { id: 3 }], culprits: [{ id: 2 }] } };
    } });
  assert.equal(result.batch.state, 'blocked');
  assert.deepEqual(reopened, [2]);
});

for (const [name, comparison] of [
  ['red on base', { main: 'base', files: [{ file: 'test/red.test.js', result: 'red' }] }],
  ['unavailable on base', { main: 'base', files: [], unavailable: 'runner unavailable' }],
]) {
  test(`clause 2: bisection holds verdicts when a failing file is ${name} [B3,C7]`, async () => {
    const writes = [];
    const state = { batch: { id: 'batch', base: 'base', root: '.', revision: 0 }, culprits: [], board: { clock: { now: () => new Date('2026-01-01T00:00:00Z') } },
      write: async (operation, args) => { writes.push(operation); return args[0].batch; }, say: () => {} };
    const failures = [{ file: 'test/red.test.js', name: 'fails' }];
    const result = await bisect(state, [{ id: 1, commit: 'candidate' }], failures, 'split', undefined, async () => comparison);
    assert.deepEqual(result, []);
    assert.equal(state.batch.state, 'blocked');
    assert.equal(state.batch.refusal.code, 'LAND_DIAGNOSTIC');
    assert.deepEqual(state.culprits, []);
    assert.deepEqual(writes, ['recordLandingBatch']);
  });
}

test('base proof requires every failing file to have a green comparison [B3,C7]', async () => {
  const state = { batch: { base: 'base', root: '.' } };
  const failures = [{ file: 'test/a.test.js' }, { file: 'test/b.test.js' }];
  const compare = async () => ({ main: 'base', files: [
    { file: 'test/a.test.js', result: 'green' }, { file: 'test/b.test.js', result: 'green' },
  ] });
  assert.equal(await landingBaseGreen(state, failures, compare), true);
  assert.equal(await landingBaseGreen(state, [...failures, { name: 'unnamed' }], compare), false);
});

test('real base comparison keeps a red or missing file from becoming a culprit [B3,C7]', async () => {
  const { landProject } = makeLandProjectFixtures(e2e);
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(e2e.commitFile(box, box.repo, 'web/land-9.test.js', '// RED NAME:base-red\n', 'test(web): record base red [G1]').status, 0);
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const state = { batch: { id: 'batch', base, root: box.repo, logPath: join(box.dir, 'batch.log'), revision: 0 },
    board: { clock: { now: () => new Date() } }, culprits: [], write: async (_operation, args) => args[0].batch, say: () => {} };
  const red = [{ file: 'web/land-9.test.js', name: 'base-red' }];
  // A red main already has never blames the item [#2941,#2945]: with named base cases it stays green (known-main);
  // when main's comparison names no cases, the batch holds instead. Either way no culprit is recorded.
  const green = await bisect(state, [{ id: 1, commit: base }], red);
  if (green.length) {
    assert.deepEqual(green, [{ id: 1, commit: base }]);
    assert.deepEqual(state.batch.knownMain, [{ file: 'web/land-9.test.js', name: 'base-red' }], 'the matching base case is recorded as known-main');
  } else {
    assert.equal(state.batch.state, 'blocked');
    assert.equal(state.batch.refusal.code, 'LAND_DIAGNOSTIC');
  }
  assert.deepEqual(state.culprits, []);
  const missing = [{ file: 'web/not-on-base.test.js', name: 'unavailable' }];
  assert.equal(await landingBaseGreen(state, missing), false);
});

test('a case base main fails by the same file and name is recorded as known-main and the item stays green [B3,C7,#2941]', async () => {
  const state = { batch: { id: 'batch', base: 'base', root: '.', revision: 0 }, culprits: [], board: { clock: { now: () => new Date('2026-01-01T00:00:00Z') } },
    write: async (_operation, args) => args[0].batch, say: () => {} };
  const failures = [{ file: 'test/red.test.js', name: 'fails' }];
  const comparison = { main: 'base', files: [{ file: 'test/red.test.js', result: 'red', failures: [{ file: 'test/red.test.js', name: 'fails' }] }] };
  const result = await bisect(state, [{ id: 1, commit: 'candidate' }], failures, 'split', undefined, async () => comparison);
  assert.deepEqual(result, [{ id: 1, commit: 'candidate' }]);
  assert.deepEqual(state.batch.knownMain, [{ file: 'test/red.test.js', name: 'fails' }]);
  assert.notEqual(state.batch.state, 'blocked');
  assert.deepEqual(state.culprits, []);
});
