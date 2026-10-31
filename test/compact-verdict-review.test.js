/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/compact-verdict-review.js src/engine.js src/verdict-freshness.js */
/** Synthetic wire and real Git/SQLite regressions; no relay, credentials or product gate claims [H3,H16,V8]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { compactReviewMove, compactReviewPaths, expandReviewPaths } from '../src/compact-verdict-review.js';
import { COMPACT_VERDICT_REVIEW_ENGINE } from '../src/compact-verdict-review-engine.js';
import { appliedSequence, applyEngineMove, engineReceipt, executableArgs, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { generateBoardKey, seal, unseal } from '../src/seal.js';
import { captureVerdictReview, verdictProjector } from '../src/verdict-freshness.js';
import { submitFixture } from './board-submit-fixture.js';
import { runFixtureGit } from './fixture-child.js';

/** Generate long shared prefixes, not private repository filenames. */
function manyPaths() {
  return Array.from({ length: 1420 }, (_, n) =>
    `web/synthetic-review-fixtures/a-long-shared-component-directory/another-shared-directory/case-${String(n).padStart(4, '0')}.txt`);
}

/** Construct a synthetic move with stable review, actor and logical identity. */
function reviewMove(paths) {
  return { version: 1, engine: ENGINE_VERSION, id: 'synthetic-review', operation: 'verify', actor: 'web-2', args: [1,
    { agentId: 'web-2', decision: 'ACCEPT', note: 'Synthetic encoding regression, not a product review.', digest: 'd'.repeat(64),
      head: 'a'.repeat(40), review: { commit: 'a'.repeat(40), head: 'a'.repeat(40), trunk: 'b'.repeat(40), paths } }] };
}

/** Assert the specific fail-closed coverage refusal, not an arbitrary exception. */
function invalid(value) {
  assert.throws(() => expandReviewPaths(value), { code: 'BAD_VERDICT_REVIEW' });
}

test('review paths are an actual readable YAML block tree with explicit literal leaves [H16,V8]', () => {
  const value = compactReviewPaths(['node', 'node.txt', 'node/child.txt', 'src/a.js', 'src/b.js']);
  assert.equal(value.format, 'pullboard-review-path-yaml-v1');
  assert.equal(value.yaml, '"node":\n  "": null\n  "child.txt": null\n"node.txt": null\n"src":\n  "a.js": null\n  "b.js": null\n');
  assert.deepEqual(expandReviewPaths(value), ['node', 'node.txt', 'node/child.txt', 'src/a.js', 'src/b.js']);
  assert.equal(compactReviewPaths([]).yaml, '{}\n');
  assert.deepEqual(expandReviewPaths(compactReviewPaths([])), []);
});

test('YAML keys retain punctuation, Unicode, line breaks and literal wildcard characters [H16,V8]', () => {
  const paths = ['__proto__/constructor', 'null', 'true', 'web/#: &*?![]{}.txt', 'web/[literal]*?.txt',
    'web/line\nbreak.txt', 'web/return\rtab\t.txt', 'web/quote"\\name.txt', 'web/space name.txt',
    'web/\u007f\u0085\u009f\u2028\u2029\ufffe\uffff.txt', 'web/\ud800.txt', 'web/é.txt', 'web/😀.txt', 'web/😁.txt'].sort();
  const encoded = JSON.parse(JSON.stringify(compactReviewPaths(paths)));
  assert.deepEqual(expandReviewPaths(encoded), paths);
  assert.ok(!/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/u.test(encoded.yaml), 'YAML-sensitive characters are escaped, not normalized');
  for (const bad of [['b', 'a'], ['a', 'a'], ['../a'], ['/a'], ['a//b'], ['a\0b'], ['a/./b'], ['a/../b']])
    assert.throws(() => compactReviewPaths(bad), { code: 'BAD_VERDICT_REVIEW' });
});

test('corrupt, omitted, duplicate, ambiguous or noncanonical YAML coverage is refused [H16,V8]', () => {
  const value = compactReviewPaths(['web/component/a', 'web/component/b']);
  const mutations = [
    v => { v.format = 'unknown'; }, v => { v.bytes += 1; }, v => { v.bytes = 32 * 1024 * 1024 + 1; },
    v => { v.sha256 = '0'.repeat(64); }, v => { v.sha256 = {}; },
    v => { v.yaml = v.yaml.replace('    "b": null\n', ''); },
    v => { v.yaml = v.yaml.replace('    "b": null', '    "a": null'); },
    v => { v.yaml = v.yaml.replace('    "a": null', '   "a": null'); },
    v => { v.yaml = v.yaml.replace('    "a": null', '\t"a": null'); },
    v => { v.yaml = v.yaml.replace('    "a": null', '      "a": null'); },
    v => { v.yaml = v.yaml.replace('"component":', '"component": null'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"a":'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"a": {}'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"a": *alias'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"a": !!null null'); },
    v => { v.yaml = v.yaml.replace('"a": null', 'a: null'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"\\u0061": null'); },
    v => { v.yaml = v.yaml.replace('"a": null', '"a/b": null'); },
    v => { v.yaml += '"empty":\n'; }, v => { v.yaml += '"": null\n'; },
    v => { v.yaml += '# comment\n'; }, v => { v.yaml = '---\n' + v.yaml; },
    v => { v.yaml = v.yaml.slice(0, -1); }, v => { v.yaml = v.yaml.replaceAll('\n', '\r\n'); },
    v => { v.extra = true; }, v => { v.yaml = null; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(value); mutate(changed); invalid(changed); }
  for (const malformed of [null, {}, [], { ...value, yaml: [] }, { ...value, bytes: 1 }]) invalid(malformed);
  // Rebind metadata too: grammar/shape rejection cannot depend only on a stale digest.
  for (const yaml of ['"a":\n  "": null\n', '"a": null\n"a": null\n', '"a": null\n"a":\n  "b": null\n',
    '"a": null\n"b":\n', '"a": null\n"b": null\n', '"..": null\n']) {
    const text = JSON.stringify(['a']);
    invalid({ format: value.format, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), yaml });
  }
});

test('wire compaction is smaller-only and leaves caller args and non-path fields exact [H3,H16,V8]', () => {
  const original = reviewMove(manyPaths()), before = structuredClone(original);
  const compact = compactReviewMove(original);
  assert.deepEqual(original, before);
  assert.ok(!Array.isArray(compact.args[1].review.paths));
  assert.ok(compact.engine >= COMPACT_VERDICT_REVIEW_ENGINE);
  const restored = structuredClone(compact);
  restored.args[1].review.paths = expandReviewPaths(restored.args[1].review.paths);
  assert.deepEqual(restored, original);
  const short = reviewMove(['a']);
  assert.equal(compactReviewMove(short), short);
  const unrelated = { ...original, operation: 'shout' };
  assert.equal(compactReviewMove(unrelated), unrelated);
});

test('a generated oversized review fits the actual sealed JSON request without a larger cap [H3,H16]', async t => {
  const original = reviewMove(manyPaths()), compact = compactReviewMove(original);
  const key = await generateBoardKey();
  const binding = { boardId: 'synthetic-encoding-board', kind: 'move', sequence: 1 };
  const sizes = [];
  for (const move of [original, compact]) {
    const plain = new TextEncoder().encode(JSON.stringify(move));
    const sealed = await seal(key, plain, binding);
    // Match relayOrdering.postPending's verify request (no registration receipt).
    const body = JSON.stringify({ sequence: 1, sealed: Buffer.from(sealed).toString('base64url') });
    sizes.push(Buffer.byteLength(body));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(await unseal(key, sealed, binding))), move);
  }
  assert.ok(sizes[0] > 100_000);
  assert.ok(sizes[1] < 100_000);
  t.diagnostic(`synthetic sealed HTTP JSON bytes: ${sizes[0]} -> ${sizes[1]}; paths: ${original.args[1].review.paths.length}`);
});

/** Capture a genuine synthetic Git delta and submit native SQLite state without claiming a gate ran. */
function submitted(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-compact-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  git('add', '.');
  git('-c', 'user.name=Encoding fixture', '-c', 'user.email=encoding@example.invalid', 'commit', '-qm', 'synthetic base');
  const trunk = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'candidate');
  const paths = [...manyPaths(), 'web/[literal]*?.txt'].sort();
  for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'candidate\n'); }
  git('add', '.');
  git('-c', 'user.name=Encoding fixture', '-c', 'user.email=encoding@example.invalid', 'commit', '-qm', 'synthetic candidate');
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  git('switch', '-q', 'main');
  const board = store.openBoard(join(root, 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: join(root, 'builder') });
  const reviewer = store.register(board, { lane: 'web', path: join(root, 'reviewer') });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Synthetic compact review' });
  const text = JSON.stringify({ rows: [], policy: { version: 1, commit: trunk, verify: { policy: 'any', family: 'off' } } });
  const digest = createHash('sha256').update(text).digest('hex');
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text, digest }) });
  submitFixture(board, id, { agentId: builder, commit, tree, policyCommit: trunk });
  const review = captureVerdictReview(root, board, store.getItem(board, id), trunk, commit);
  assert.deepEqual(review.paths, paths);
  const options = { ...reviewMove(paths).args[1], agentId: reviewer, digest, head: commit, review };
  return { root, git, board, id, reviewer, options, paths, trunk };
}

test('native capture, decode, refusals, stored arrays and literal freshness retain semantics [H3,H16,V8]', t => {
  const box = submitted(t);
  const { board, id, options, paths } = box;
  const move = prepareEngineMove(board, 'verify', [id, options], { id: 'native-compact-review', actor: box.reviewer });
  assert.ok(!Array.isArray(move.args[1].review.paths));
  assert.deepEqual(executableArgs(move, board)[1].review, options.review);
  for (const engine of [COMPACT_VERDICT_REVIEW_ENGINE - 1, ENGINE_VERSION + 1]) {
    assert.throws(() => applyEngineMove(board, { ...move, engine }, { sequence: 1, at: '2026-10-30T12:00:00Z' }), { code: 'ENGINE_VERSION' });
    assert.equal(appliedSequence(board), 0);
    assert.equal(engineReceipt(board, move.id), null);
  }
  const malformed = structuredClone(move);
  malformed.id = 'corrupt-review'; malformed.args[1].review.paths.yaml += '"unexpected": null\n';
  const refused = applyEngineMove(board, malformed, { sequence: 1, at: '2026-10-30T12:00:00Z' });
  assert.equal(refused.error?.code, 'BAD_VERDICT_REVIEW');
  assert.equal(store.verdictsFor(board, id).length, 0);
  const outcome = applyEngineMove(board, move, { sequence: 2, at: '2026-10-30T12:00:01Z' });
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  assert.deepEqual(store.verdictsFor(board, id)[0].review, options.review);
  assert.deepEqual(applyEngineMove(board, move, { sequence: 2, at: '2026-10-30T12:00:01Z' }), outcome);
  const unrelated = ['unrelated.txt', 'web/literal-neighbor.txt', paths.at(-1).replace('1419', '1420')];
  for (const path of [...unrelated, paths[0], paths.at(-1), 'web/[literal]*?.txt']) {
    box.git('switch', '-qC', 'main', box.trunk);
    mkdirSync(dirname(join(box.root, path)), { recursive: true }); writeFileSync(join(box.root, path), 'trunk change\n');
    box.git('add', '--', path);
    box.git('-c', 'user.name=Encoding fixture', '-c', 'user.email=encoding@example.invalid', 'commit', '-qm', 'synthetic trunk change');
    const state = verdictProjector(box.root, board).state(store.getItem(board, id));
    if (unrelated.includes(path)) assert.equal(state, null, 'neither directory coverage nor wildcard matching is introduced');
    else { assert.equal(state?.code, 'STALE_VERDICT'); assert.equal(state.file, path); }
  }
  assert.deepEqual(store.verdictsFor(board, id)[0].review.paths, paths, 'freshness never rewrites the review');
});
