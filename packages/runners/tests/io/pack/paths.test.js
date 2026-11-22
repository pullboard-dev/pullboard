/** @pullboard-test-input packages/runners/src/io/pack.js packages/runners/src/io/source/scan.js */
/** Call-local historical path reuse preserves full prefixes and refuses incomplete inventories [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withPackPaths } from '../../fixtures/pack-paths.js';

test('runners.pack-paths.shared-prefixes: clause 1: existing tree stream reduces total Git jobs and repeated path checks with exact full-prefix, policy, root and object-order parity [C7]', async t => {
  await withPackPaths(t, ({ pack, legacyHistoryPack, expected: expectedPack, launches, reset, commits, protect }) => {
    const expected = expectedPack();
    reset();
    const baseline = pack({}, [], legacyHistoryPack);
    const before = launches().length;
    reset();
    const first = pack();
    const after = launches().length;
    assert.deepEqual(first.bytes, expected, 'exact object order matches independent Git selection');
    assert.deepEqual(first.bytes, baseline.bytes, 'the original recursive path walk produces identical bytes');
    assert.equal(before - after, 12, 'the twelve root ls-tree processes disappear without replacement Git launches');
    assert.ok(first.checks < baseline.checks, 'actual full-path policy invocations fall across repeated subtrees');
    assert.ok(first.checks > 128, 'both mounts and each root still undergo their full-prefix checks');
    reset();
    const duplicate = { extraCommits: [commits[0], commits.at(-1), commits[0]] };
    assert.deepEqual(pack(duplicate).bytes, pack(duplicate, [], legacyHistoryPack).bytes, 'duplicate root argument ordering matches the original exactly');
    const policies = [
      protect,
      { ...protect, blocked: ['z/leaf0.txt'] },
      { ...protect, blocked: ['z/leaf0.txt'], allowed: ['z/leaf0.txt'] },
      { ...protect, blocked: ['a/leaf0.txt'] },
    ];
    for (const policy of policies) {
      const source = { protect: policy };
      const actual = pack(source), original = pack(source, [], legacyHistoryPack);
      assert.equal(actual.code, original.code);
      assert.equal(actual.message, original.message);
      assert.deepEqual(actual.bytes, original.bytes, 'each exact policy retains its original result');
    }
    assert.equal(pack({ protect: policies[1] }).code, 'RUNNER_SECRET', 'a clean mount at a cannot vouch for z');
    assert.ok(pack({ protect: policies[2] }).bytes, 'the exact allowed exception remains effective');
    for (const tips of [[commits.at(-1)], [commits[0]]]) {
      assert.deepEqual(pack({}, tips).bytes, pack({}, tips, legacyHistoryPack).bytes, 'known history and incomplete tree-stream closures retain exact original output');
    }
    reset(); pack();
    assert.equal(launches().length, after, 'another call performs its own complete scan without persistent proofs');
    t.diagnostic(JSON.stringify({ historicalRoots: 12, totalGitBefore: before, totalGitAfter: after, pathChecksBefore: baseline.checks, pathChecksAfter: first.checks }));
  });
});

test('runners.pack-paths.fail-closed: clause 1: unknown scanner identity still scans, failed or malformed streams refuse, and every extra historical root retains exact policy and error parity [C7]', async t => {
  await withPackPaths(t, async ({ pack, legacyHistoryPack, git, commits, protect, setReply, importExtra }) => {
    for (const [reply, code] of [['malformed', 'RUNNER_SOURCE'], ['fail', 'RUNNER_SOURCE']]) {
      setReply(reply);
      const refused = pack(), original = pack({}, [], legacyHistoryPack);
      assert.equal(refused.code, code);
      assert.equal(refused.code, original.code);
      assert.equal(refused.message, original.message);
      assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
    }
    setReply('');
    const tree = git('mktree', '-z');
    const extra = git('commit-tree', tree, '-m', 'empty side');
    const source = { extraCommits: [extra] };
    const safe = pack(source);
    assert.deepEqual(safe.bytes, pack(source, [], legacyHistoryPack).bytes);
    await importExtra(safe.bytes, extra);
    const old = commits[0];
    const blocked = { commit: extra, extraCommits: [old], protect: { ...protect, blocked: ['z/leaf0.txt'] } };
    const refused = pack(blocked), original = pack(blocked, [], legacyHistoryPack);
    assert.equal(refused.code, 'RUNNER_SECRET', 'unknown scanner identity never skips checks on an extra root');
    assert.equal(refused.message, original.message);
    assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
  });
});
