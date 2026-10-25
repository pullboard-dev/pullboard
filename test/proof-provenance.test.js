/** Native provenance rejects borrowed evidence and keeps unknown facts explicit [C7,H16]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { prepareEngineMove, applyEngineMove } from '../src/engine.js';
import { boardReceiptStore, receiptBody, receiptFields } from '../src/gate-run-receipt.js';
import { proofCounts } from '../src/proof-provenance.js';
import { runShell } from '../src/shell-run.js';
import { captureTestRuntimes, testRuntimeEnvironment } from '../src/execution-environment.js';
import { runFixtureChild } from './fixture-child.js';
import { fileURLToPath } from 'node:url';
import { bindRefs, resolveMove, strayItemRefs } from '../src/relay-outbox.js';
import { recordNativeProof } from '../src/proof-cli.js';
import { createE2eHelpers } from './e2e-helpers.js';

test('a real failed native check records its exit without invented runtime or counters [C7,H16]', (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-failed-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, 'actual-child.json');
  const program = `require('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,environment:{node:process.versions.node,platform:process.platform,arch:process.arch}}));process.exit(7);`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
  const box = helpers.project(command);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'A real red proof',
    criterion: 'The process exits successfully.', specIds: ['G1'], check: command });
  const claim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err || claim.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/uncommitted.txt'), 'not in a commit\n');
  const check = box.run(box.web, 'check', String(id), '--yes', '--json');
  assert.equal(check.code, 1, check.out);
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err || shown.out);
  const [receipt] = JSON.parse(shown.out).proofReceipts;
  assert.equal(receipt.kind, 'check');
  assert.equal(receipt.exitCode, 7);
  assert.equal(receipt.sourceClean, false);
  assert.equal(receipt.commit, null, 'a dirty check cannot attest the committed HEAD');
  assert.equal(receipt.tree, null, 'a dirty check cannot attest the committed tree');
  assert.deepEqual(receipt.counts, { passed: null, failed: null, skipped: null });
  const actual = JSON.parse(readFileSync(trace, 'utf8'));
  if (receipt.testRuntimes === null) {
    assert.equal(receipt.environment, null, 'an unknown custom command never borrows its launcher runtime');
  } else {
    assert.deepEqual(receipt.testRuntimes, [{ ...actual, file: null }], 'a known runtime belongs to the actual failed child');
    assert.deepEqual(receipt.environment, actual.environment, 'the common runtime matches the actual child, not the controller');
  }
});

test('native receipts carry each child reported runtime instead of borrowing the launcher [C7,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  box.env.NODE_OPTIONS = '';
  const paths = [join(box.dir, 'first-runtime.json'), join(box.dir, 'second-runtime.json')];
  const programs = paths.map(path => `require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid,node:process.versions.node,platform:process.platform,arch:process.arch,argv:process.argv,execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',hasNodeOptions:Object.hasOwn(process.env,'NODE_OPTIONS')}));`);
  // Separate actual processes must remain distinct even when they happen to run the same Node version.
  // Approved MIN/current runner images have both versions; a single-runtime install still exercises two real children.
  const alternate = ['24.21.0', '22.13.1'].map(version => join(dirname(process.execPath), '..', '..', 'v' + version, 'bin', 'node'))
    .find(path => path !== process.execPath && existsSync(path)) ?? process.execPath;
  const executables = [process.execPath, alternate];
  const bare = programs.map((program, index) => {
    const result = runFixtureChild(executables[index], ['-e', program], { cwd: box.web, env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure || result.stderr);
    return JSON.parse(readFileSync(paths[index], 'utf8'));
  });
  const command = programs.map((program, index) => `${JSON.stringify(executables[index])} -e ${JSON.stringify(program)}`).join(' && ');
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two actual check runtimes',
    criterion: 'Both child processes report their runtimes.', check: command, specIds: ['G1'] });
  for (const args of [['claim', String(id), '--json'], ['check', String(id), '--yes', '--json']]) {
    const result = box.run(box.web, ...args);
    assert.equal(result.code, 0, result.err + result.out);
  }
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err + shown.out);
  const [receipt] = JSON.parse(shown.out).proofReceipts;
  assert.ok(Array.isArray(receipt.testRuntimes), 'the receipt lists child reports, not only one worker environment');
  const actualChildren = [];
  for (const [index, path] of paths.entries()) {
    const actual = JSON.parse(readFileSync(path, 'utf8'));
    for (const field of ['argv', 'execArgv', 'nodeOptions', 'hasNodeOptions']) {
      assert.deepEqual(actual[field], bare[index][field], 'a receipted native child retains its caller ' + field);
    }
    actualChildren.push(actual);
    const recorded = receipt.testRuntimes.find(runtime => runtime.pid === actual.pid);
    assert.ok(recorded, 'every actual command child has a self-reported receipt');
    assert.deepEqual(recorded.environment, { node: actual.node, platform: actual.platform, arch: actual.arch });
  }
  assert.equal(new Set(receipt.testRuntimes.map(runtime => runtime.pid)).size, receipt.testRuntimes.length);
  const versions = new Set(actualChildren.map(child => child.node));
  t.diagnostic('actual child Node versions: ' + [...versions].join(', '));
  if (versions.size > 1) assert.equal(receipt.environment, null, 'a mixed actual run has no invented common Node version');
});

test('a receipted native node test preserves caller output and records its actual worker [C7,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  delete box.env.NODE_TEST_CONTEXT;
  const trace = join(box.dir, 'native-worker.json');
  const file = join(box.dir, 'native-worker.test.cjs');
  writeFileSync(file, `require('node:child_process').execFileSync('git',['--version']);require('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,node:process.versions.node,argv:process.argv,execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',hasNodeOptions:Object.hasOwn(process.env,'NODE_OPTIONS')}));require('node:test')('native selected worker [G1]',()=>{});`);
  const bare = runFixtureChild(process.execPath, ['--test', file], { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(bare.status, 0, bare.failure || bare.stderr);
  const expected = JSON.parse(readFileSync(trace, 'utf8'));
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Native selected runtime',
    criterion: 'Actual native worker retains caller behavior.', check: `${JSON.stringify(process.execPath)} --test ${JSON.stringify(file)}`, specIds: ['G1'] });
  for (const args of [['claim', String(item), '--json'], ['check', String(item), '--yes', '--json']]) {
    const result = box.run(box.web, ...args);
    assert.equal(result.code, 0, result.err + result.out);
  }
  const actual = JSON.parse(readFileSync(trace, 'utf8'));
  for (const field of ['argv', 'execArgv', 'nodeOptions', 'hasNodeOptions']) assert.deepEqual(actual[field], expected[field], field);
  const shown = box.run(box.repo, 'show', String(item), '--json');
  assert.equal(shown.code, 0, shown.err + shown.out);
  const [receipt] = JSON.parse(shown.out).proofReceipts;
  assert.ok(receipt.testRuntimes?.some(row => row.pid === actual.pid && row.environment.node === actual.node),
    'the actual native worker self-reports rather than borrowing its node --test launcher');
});

test('an unobserved custom nested Node child never borrows its launcher runtime [C7,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-nested-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const actualPath = join(directory, 'child.json');
  const alternate = ['24.21.0', '22.13.1'].map(version => join(dirname(process.execPath), '..', '..', 'v' + version, 'bin', 'node'))
    .find(path => path !== process.execPath && existsSync(path)) ?? process.execPath;
  const childProgram = `require('node:fs').writeFileSync(${JSON.stringify(actualPath)},JSON.stringify({pid:process.pid,node:process.versions.node}));`;
  const launcher = `require('node:child_process').execFileSync(${JSON.stringify(alternate)},['-e',${JSON.stringify(childProgram)}]);`;
  const capture = captureTestRuntimes(process.env);
  t.after(() => capture.finish());
  const result = runFixtureChild(process.execPath, ['-e', launcher], { env: capture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr);
  const actual = JSON.parse(readFileSync(actualPath, 'utf8'));
  assert.equal(actual.node, alternate === process.execPath ? process.versions.node : alternate.split('/v').at(-1).split('/')[0]);
  assert.equal(capture.finish(), null, 'unknown custom execution cannot inherit the launcher runtime');
});

test('runtime capture binds the admitted file to its closed actual worker [C7,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  const file = join(box.repo, 'test/runtime-child.test.js');
  writeFileSync(file, "require('node:test')('the actual worker executes [G1]',()=>{});\n");
  box.git(box.repo, 'add', 'test/runtime-child.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record the actual admitted test file');
  const capture = captureTestRuntimes(box.env);
  t.after(() => capture.finish());
  const result = runFixtureChild(process.execPath, [fileURLToPath(new URL('../bin/run-tests.js', import.meta.url)), file],
    { cwd: box.repo, env: capture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const children = capture.finish();
  assert.ok(children && children.length === 1, 'the dispatcher identifies exactly one test child rather than its launcher');
  assert.equal(children[0].file, 'test/runtime-child.test.js');
  assert.deepEqual(children[0].environment, { platform: process.platform, arch: process.arch, node: process.versions.node });
  assert.notEqual(children[0].pid, process.pid);
  const outside = join(box.dir, 'external-runtime.test.js');
  writeFileSync(outside, "require('node:test')('external selected worker [G1]',()=>{});\n");
  const externalCapture = captureTestRuntimes(box.env);
  t.after(() => externalCapture.finish());
  const externalRun = runFixtureChild(process.execPath, [fileURLToPath(new URL('../bin/run-tests.js', import.meta.url)), outside],
    { cwd: box.repo, env: externalCapture.env, encoding: 'utf8' });
  assert.equal(externalRun.status, 0, externalRun.failure || externalRun.stderr || externalRun.stdout);
  const external = externalCapture.finish();
  assert.equal(external.length, 1, 'one closed admitted external worker excludes its launcher');
  assert.equal(external[0].file, null, 'a selected external file has no invented relative checkout path');
  assert.deepEqual(external[0].environment, { platform: process.platform, arch: process.arch, node: process.versions.node });
});

test('timed shell proof records the actual command child rather than the timeout worker [C7,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-timed-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, 'actual.json');
  const program = `require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,node:process.versions.node}));`;
  const result = runShell(directory, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`,
    { timeoutMs: 5_000, captureRuntimes: true }); // budget: declared timeout input exercises the real custody worker.
  assert.equal(result.isGreen, true, result.output);
  assert.ok(JSON.parse(readFileSync(trace, 'utf8')).pid > 0, 'the opaque command really executed');
  assert.equal(result.testRuntimes, null, 'custody preloads cannot prove an opaque custom command has no synchronous descendants');
  const selected = join(directory, 'selected-runtime.test.cjs');
  writeFileSync(selected, program + "require('node:test')('selected actual timed worker [G1]',()=>{});\n");
  const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
  const admitted = runShell(directory, `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} ${JSON.stringify(selected)}`,
    { timeoutMs: 5_000, captureRuntimes: true }); // budget: the same bounded real custody path now runs an admitted selected worker.
  assert.equal(admitted.isGreen, true, admitted.output);
  const actual = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(admitted.testRuntimes.length, 1, 'the timeout launcher never substitutes for the actual selected worker');
  assert.equal(admitted.testRuntimes[0].pid, actual.pid);
  assert.equal(admitted.testRuntimes[0].file, 'selected-runtime.test.cjs');
  assert.equal(admitted.testRuntimes[0].environment.node, actual.node);
});

test('child boot reports remain read only and a writable replacement stays unknown [C7,H16]', t => {
  const capture = captureTestRuntimes(process.env);
  t.after(() => capture.finish());
  const result = runFixtureChild(process.execPath, ['-e', 'void 0'], { env: capture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr);
  const directory = capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR;
  const name = readdirSync(directory).find(name => /^runtime-/.test(name));
  assert.ok(name, 'the actual child wrote a boot report');
  const file = join(directory, name);
  assert.equal(statSync(file).mode & 0o222, 0, 'ordinary child writes cannot replace the sampled boot report');
  chmodSync(file, 0o600);
  const changed = JSON.parse(readFileSync(file, 'utf8'));
  changed.environment.node = '0.0.0';
  writeFileSync(file, JSON.stringify(changed));
  assert.equal(capture.finish(), null, 'a writable report is not accepted as native runtime evidence');
});

test('proof counters retain explicit totals and do not invent success from missing output [C7,H16]', () => {
  const unknown = { passed: null, failed: null, skipped: null };
  assert.deepEqual(proofCounts('no test reporter\n'), unknown);
  assert.deepEqual(proofCounts('# pass 1\n# fail 0\n'), unknown);
  assert.deepEqual(proofCounts('    # pass 9\n    # fail 0\n    # skipped 0'), unknown, 'nested child summaries are not added twice');
  assert.deepEqual(proofCounts('# pass 2\n# fail 1\n# skipped 3\nℹ pass 4\nℹ fail 0\nℹ skipped 1'),
    { passed: 6, failed: 1, skipped: 4 });
  assert.deepEqual(proofCounts('# pass 1\n# fail 0\n# skipped 0\n# pass 8'), unknown,
    'an incomplete later summary cannot turn the whole run into a known total');
});

test('an executed run without its receipt cannot publish an outcome [C7,H16]', async () => {
  let moves = 0;
  const services = { ordered: () => { moves += 1; }, withBoard: () => { moves += 1; }, resourceAgent: () => 'web-1' };
  await assert.rejects(recordNativeProof({}, { item_id: 1 }, { proofReceiptId: null }, services),
    error => error.code === 'PROOF_RUN_UNAVAILABLE');
  await recordNativeProof({}, { item_id: 1 }, { executed: false }, services);
  assert.equal(moves, 0, 'a zero-execution refusal creates no proof receipt');
});

test('proof receipts bind the native actor and replay without the origin filesystem [C7,H16]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-proof-receipts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = store.openBoard(join(directory, 'board.sqlite'));
  const replica = store.openBoard(':memory:');
  t.after(() => { store.closeBoard(replica); store.closeBoard(board); });
  let item;
  for (const target of [board, replica]) {
    store.register(target, { lane: 'coordinator', path: '/proof-coordinator' });
    store.register(target, { lane: 'web', path: '/proof-builder' });
    store.register(target, { lane: 'web', path: '/proof-peer' });
    item = store.addItem(target, { by: 'coordinator', lane: 'web', title: 'A synthetic receipt boundary' });
  }
  // This is synthetic storage-boundary evidence, not a claim that this fixture ran a gate.
  const receipt = { version: 2, id: '00000000-0000-4000-8000-00000000c0de', kind: 'check',
    head: 'a'.repeat(40), tree: 'b'.repeat(40), main: null, command: 'c'.repeat(64), green: false,
    failures: [], load: null, at: '2026-10-23T00:00:00.000Z',
    proof: { item, frozenDigest: null, seat: 'web-1', environment: null, runner: null, exitCode: 7,
      counts: { passed: null, failed: null, skipped: null }, durationMs: 37, sourceClean: false } };
  assert.throws(() => store.recordProofRun(board, { agentId: 'web-1', itemId: item, receipt }),
    error => error.code === 'PROOF_RUN_UNBOUND', 'caller-written fields without a native file never establish a direct proof');
  mkdirSync(boardReceiptStore(board));
  writeFileSync(join(boardReceiptStore(board), `${receipt.id}.json`), receiptBody(receipt));
  assert.throws(() => store.recordProofRun(board, { agentId: 'web-2', itemId: item, receiptId: receipt.id }),
    error => error.code === 'PROOF_RUN_ACTOR', 'a peer cannot appropriate a real native receipt');
  assert.throws(() => prepareEngineMove(board, 'recordProofRun', [{ agentId: 'web-1', itemId: item,
    receipt: { ...receipt, proof: { ...receipt.proof, exitCode: 0 } } }]), error => error.code === 'PROOF_RUN_UNBOUND');
  const args = [{ agentId: 'web-1', itemId: item, receiptId: receipt.id }];
  const move = prepareEngineMove(board, 'recordProofRun', args, { actor: 'web-1' });
  const recorded = store.recordProofRun(board, args[0]);
  assert.equal(recorded.exitCode, 7);
  assert.equal(recorded.environment, null, 'missing executor identity never becomes controller identity');
  assert.equal(recorded.parentSession, null, 'a legacy seat never becomes recorded-parent assurance');
  assert.deepEqual(recorded.counts, receipt.proof.counts);
  applyEngineMove(replica, move, { sequence: 1, at: receipt.at });
  const [{ eventId, ...replayed }] = store.proofReceipts(replica, item);
  assert.deepEqual(replayed, recorded);
  assert.equal(store.proofReceipts(board, item).length, 1);
  store.recordProofRun(board, args[0]);
  assert.equal(store.proofReceipts(board, item).length, 1, 'retrying the same receipt is idempotent');
  assert.equal(receiptFields({ ...receipt, proof: { ...receipt.proof, environment: { node: '22', platform: 'darwin' } } }), null);
});


test('an offline proof receipt follows the item its queued add actually creates [B26,H16,C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-proof-renumber-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = store.openBoard(join(directory, 'origin.sqlite'));
  const replica = store.openBoard(':memory:');
  t.after(() => { store.closeBoard(replica); store.closeBoard(origin); });
  for (const target of [origin, replica]) {
    store.register(target, { lane: 'coordinator', path: '/renumber-coordinator' });
    store.register(target, { lane: 'web', path: '/renumber-builder' });
  }
  const addArgs = [{ by: 'coordinator', lane: 'web', title: 'The offline proof item' }];
  const add = prepareEngineMove(origin, 'addItem', addArgs, { id: 'offline-proof-add', actor: 'coordinator' });
  const local = store.addItem(origin, addArgs[0]);
  const unrelated = store.addItem(replica, { by: 'coordinator', lane: 'web', title: 'Another machine took this number' });
  const at = '2026-10-23T00:00:00.000Z';
  const added = applyEngineMove(replica, add, { sequence: 1, at });
  assert.equal(added.error, undefined);
  const remote = added.result;
  assert.equal(local, unrelated, 'the competing add consumed the old local number');
  assert.notEqual(remote, local, 'the actual replay assigned the offline item a different number');
  // Synthetic receipt storage tests reference binding, not a claim that this fixture executed a gate.
  const receipt = { version: 2, id: '00000000-0000-4000-8000-00000000b26e', kind: 'check',
    head: 'a'.repeat(40), tree: 'b'.repeat(40), main: null, command: 'c'.repeat(64), green: false,
    failures: [], load: null, at,
    proof: { item: local, frozenDigest: null, seat: 'web-1', environment: null, runner: null, exitCode: 7,
      counts: { passed: null, failed: null, skipped: null }, durationMs: 37, sourceClean: false } };
  mkdirSync(boardReceiptStore(origin));
  const file = join(boardReceiptStore(origin), `${receipt.id}.json`);
  const nativeBody = receiptBody(receipt);
  writeFileSync(file, nativeBody);
  const move = prepareEngineMove(origin, 'recordProofRun', [{ agentId: 'web-1', itemId: local, receiptId: receipt.id }],
    { id: 'offline-proof-run', actor: 'web-1' });
  const outbox = { moves: [{ move: add, visible: local }], results: { [add.id]: remote } };
  assert.deepEqual(strayItemRefs(outbox, move), [], 'every item reference in the canonical proof can be queued');
  const entry = { move, refs: bindRefs(outbox, move) };
  const resolved = resolveMove(entry, outbox);
  assert.deepEqual(resolved.lost, []);
  assert.equal(resolved.move.args[0].itemId, remote);
  assert.equal(resolved.move.args[0].receipt.proof.item, remote, 'the canonical receipt and operation stay bound to one item');
  const replay = applyEngineMove(replica, resolved.move, { sequence: 2, at });
  assert.equal(replay.error, undefined);
  assert.equal(store.proofReceipts(replica, remote).length, 1);
  assert.equal(store.proofReceipts(replica, unrelated).length, 0, 'the other machine item receives no borrowed proof');
  assert.deepEqual(applyEngineMove(replica, resolved.move, { sequence: 2, at }), replay, 'same-position retry remains idempotent');
  assert.equal(readFileSync(file, 'utf8'), nativeBody, 'wire reference remapping never edits the origin native receipt file');
});

// Synthetic schema/replay controls; these rows do not claim an actual child was executed.
test('child runtime fields preserve legacy bytes and replay mixed environments without a common runtime [C7,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-child-runtime-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = store.openBoard(join(directory, 'board.sqlite'));
  const replica = store.openBoard(':memory:');
  t.after(() => { store.closeBoard(replica); store.closeBoard(board); });
  let item;
  for (const target of [board, replica]) {
    store.register(target, { lane: 'coordinator', path: '/runtime-coordinator' });
    store.register(target, { lane: 'web', path: '/runtime-builder' });
    item = store.addItem(target, { by: 'coordinator', lane: 'web', title: 'Synthetic child runtime replay' });
  }
  const legacy = { version: 2, id: '00000000-0000-4000-8000-00000000c11d', kind: 'check',
    tree: 'b'.repeat(40), head: 'a'.repeat(40), main: null, command: 'c'.repeat(64), green: false,
    failures: [], load: null, at: '2026-10-23T00:00:00.000Z',
    proof: { item, frozenDigest: null, environment: null, seat: 'web-1', runner: null, exitCode: 7,
      counts: { passed: null, failed: null, skipped: null }, durationMs: 37, sourceClean: false } };
  assert.equal(receiptBody(legacy), JSON.stringify(legacy) + '\n', 'absent child fields keep exact historical canonical bytes');
  assert.equal(Object.hasOwn(receiptFields(legacy).proof, 'testRuntimes'), false);
  const environment = { platform: 'darwin', arch: 'arm64', node: '22.13.1' };
  const rows = [{ pid: 101, environment, file: 'test/first.test.js' },
    { pid: 102, environment: { ...environment, node: '24.21.0' }, file: 'test/second.test.js' }];
  assert.equal(testRuntimeEnvironment([rows[0], { ...rows[1], file: null }]), null,
    'an authenticated external worker still participates in mixed runtime accounting');
  const supplied = { ...legacy, proof: { ...legacy.proof, environment, testRuntimes: rows } };
  const checked = receiptFields(supplied);
  assert.equal(checked.proof.environment, null, 'mixed actual child versions cannot borrow the declared launcher environment');
  assert.deepEqual(checked.proof.testRuntimes, rows);
  const unknown = receiptFields({ ...supplied, proof: { ...supplied.proof, testRuntimes: null } });
  assert.equal(unknown.proof.testRuntimes, null);
  assert.equal(unknown.proof.environment, null, 'explicit unknown children do not become a known launcher');
  for (const invalid of [undefined, [], {}, [{}], [{ ...rows[0], pid: 0 }],
    [{ ...rows[0], environment: { ...environment, node: 'not-a-version' } }],
    [{ ...rows[0], file: '../escape.test.js' }], [rows[0], rows[0]]]) {
    assert.equal(receiptFields({ ...supplied, proof: { ...supplied.proof, testRuntimes: invalid } }), null,
      'malformed supplied child rows are rejected rather than silently omitted');
  }
  mkdirSync(boardReceiptStore(board));
  writeFileSync(join(boardReceiptStore(board), `${supplied.id}.json`), receiptBody(supplied));
  const args = [{ agentId: 'web-1', itemId: item, receiptId: supplied.id }];
  const move = prepareEngineMove(board, 'recordProofRun', args, { actor: 'web-1' });
  const recorded = store.recordProofRun(board, args[0]);
  assert.equal(recorded.environment, null);
  assert.deepEqual(recorded.testRuntimes, rows);
  assert.equal(applyEngineMove(replica, move, { sequence: 1, at: supplied.at }).error, undefined);
  const [{ eventId, ...replayed }] = store.proofReceipts(replica, item);
  assert.deepEqual(replayed, recorded, 'sealed native replay preserves every child environment without the origin files');
});
