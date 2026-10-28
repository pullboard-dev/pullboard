/** @pullboard-test-input source-tree */
/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { configFromSource } from '../src/config.js';
import { boardReceiptStore, readGateReceipt, receiptStore } from '../src/gate-run-receipt.js';
import { appliedSequence, applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { prepareTrainLanding } from '../src/train-landing.js';
import { TRAIN_LANDING_ENGINE } from '../src/train-landing-engine.js';
import { nativePushReceiptProblems } from '../src/push-native-evidence.js';
import { pushedFirstParentCommits } from '../src/pre-push-receipts.js';
import { runFixtureChild, safeFixtureDiagnostic } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { submitFixture } from './board-submit-fixture.js';
import { mainAuditKey } from '../src/main-audit-state.js';
import { prepareCommitMetadata } from '../src/commit-metadata.js';

/** Require the exact native release job and its source-bound full collection receipt. */
function completedAudit(box, activation, batch, token) {
  const directory = join(box.repo, '.git/pullboard/main-audits');
  const identity = { board: activation.board, batchId: batch.id, tip: batch.tip, tree: batch.proof.tree };
  const key = `${mainAuditKey(identity)}-release-${token}`;
  const path = join(directory, `${key}.json`);
  assert.ok(existsSync(path), 'the explicit release worker produced its own job');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  for (const [name, value] of Object.entries(identity)) assert.equal(job[name], value);
  assert.equal(job.state, 'complete', JSON.stringify(job));
  assert.equal(job.green, true);
  assert.equal(job.cleanupVerified, true);
  for (const name of ['cleanupNeeded', 'incomplete', 'error']) assert.equal(job[name], undefined, JSON.stringify(job));
  const receipt = readGateReceipt(receiptStore(box.repo), job.receiptId);
  assert.ok(receipt, 'completion retains a real native receipt');
  assert.equal(receipt.kind, 'land');
  assert.equal(receipt.head, batch.tip);
  assert.equal(receipt.tree, batch.proof.tree);
  assert.equal(receipt.green, true);
  assert.equal(receipt.collection?.batchId, batch.id);
  assert.equal(receipt.collection.complete, true);
  assert.equal(receipt.collection.full, true);
  assert.ok(receipt.collection.plannedFiles > 0);
  assert.equal(existsSync(join(directory, `source-${key}`)), false, 'the native worker removed its owned source');
}

/** Bootstrap unknown cadence explicitly, then await the native producer before removing its fixture. */
async function finishAudits(box, waitFor) {
  const directory = join(box.repo, '.git/pullboard/main-audits');
  const activationPath = join(directory, 'activation.json');
  if (!existsSync(activationPath)) return false;
  const activation = JSON.parse(readFileSync(activationPath, 'utf8'));
  const pending = onBoard(box, board => store.events(board).filter(event => event.event_id > activation.afterEventId
    && event.event_kind === 'landing_batch' && JSON.parse(event.event_detail).batch.state === 'landed')
    .map(event => JSON.parse(event.event_detail).batch));
  if (!pending.length) return false;
  const owner = join(directory, 'owner.json');
  // A scheduled nudge with unknown cadence deliberately does no work. A release audit is explicit.
  await waitFor(() => !existsSync(owner), 'the prior native audit owner drains', 60_000); // budget: hang-only cleanup ceiling.
  for (const batch of pending) {
    if (!box.auditTokens.has(batch.id)) {
      assert.equal(batch.id, pending.at(-1).id, 'each earlier landing was audited before the next landing');
      const token = randomUUID();
      const env = { ...box.env };
      // This independent private fixture worker acquires its own native slots, as the production nudge does.
      for (const name of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
        'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[name];
      box.auditTokens.set(batch.id, token); // A failed or unobserved job is inspected, never silently executed again.
      const result = runFixtureChild(process.execPath, [join(box.repo, 'bin/main-audit.js'), box.repo, token, '--release'],
        { cwd: box.repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    }
    completedAudit(box, activation, batch, box.auditTokens.get(batch.id));
  }
  await waitFor(() => !existsSync(owner), 'the real audits and owned cleanup finish', 60_000); // budget: hang-only cleanup ceiling.
  return true;
}

/** Read or mutate only this test's private real SQLite board. */
function onBoard(box, action) {
  // @pullboard-board-file journey: inspect the private fixture board shared with real push and native audit flows
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Prepare real private source and policy; all gate receipts are produced by actual native executions. */
function fixture(t, required = true) {
  const helpers = createE2eHelpers();
  const box = helpers.project('node bin/run-tests.js', undefined, { withWorktree: false });
  box.auditTokens = new Map();
  t.after(async () => { await finishAudits(box, helpers.waitFor); helpers.cleanup(); });
  delete box.env.NODE_TEST_CONTEXT;
  for (const name of ['src', 'bin', 'package.json']) cpSync(new URL(`../${name}`, import.meta.url), join(box.repo, name), { recursive: true });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/train.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('the actual train body [C7]',()=>assert.notEqual(process.env.TRAIN_RED,'1'));\n");
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config,
    landing: { publish: 'separate', requireReceipts: required }, pushReceiptCheck: { smoke: 'node -e ""' } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare native train fixture');
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  return { ...box, base, waitFor: helpers.waitFor };
}

/** Establish synthetic lifecycle acceptance while retaining a genuine committed item source, not invented gate proof. */
function verifiedItem(box, number) {
  const before = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const setup = onBoard(box, board => {
    const actor = store.register(board, { lane: 'web', path: join(box.dir, `private-builder-${number}`) });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Train fixture ${number}`, criterion: 'Retain the committed item.', specIds: ['G1'] });
    const frozen = JSON.stringify({ criterion: 'Retain the committed item.' });
    const digest = createHash('sha256').update(frozen).digest('hex');
    store.claim(board, id, { agentId: actor, lane: 'web', leaseMs: 3_600_000, head: before, freeze: () => ({ text: frozen, digest }) });
    return { actor, id, digest };
  });
  writeFileSync(join(box.repo, `web/item-${number}.txt`), `actual item ${number}\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', `feat(web): retain fixture item ${number} [G1]`);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
  onBoard(box, board => {
    submitFixture(board, setup.id, { agentId: setup.actor, commit, tree });
    store.verify(board, setup.id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'synthetic lifecycle setup, not a gate claim', head: commit, digest: setup.digest, policy: 'any' });
  });
  return setup.id;
}

/** Produce a fresh native gate receipt through the actual public CLI. */
function gate(box, red = false) {
  const prior = box.env.TRAIN_RED;
  if (red) box.env.TRAIN_RED = '1';
  let result;
  try { result = box.run(box.repo, 'gate', '--landing', '--receipt', '--json'); }
  finally { if (prior === undefined) delete box.env.TRAIN_RED; else box.env.TRAIN_RED = prior; }
  assert.equal(result.code, red ? 1 : 0, `${result.out}${result.err}`);
  const value = JSON.parse(result.out);
  assert.ok(value.receiptId, result.out);
  return readGateReceipt(receiptStore(box.repo), value.receiptId);
}

/** Execute a real complete collection audit and record its native result through the public board operation. */
async function audit(box, batch) {
  const batchId = typeof batch === 'string' ? batch : batch.id;
  const latest = onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing_batch'
    && JSON.parse(event.event_detail).batch.state === 'landed').at(-1));
  assert.equal(JSON.parse(latest.event_detail).batch.id, batchId, 'the explicit full audit covers the requested latest landing');
  if (await finishAudits(box, box.waitFor)) return;
  const source = `import {runGate} from ${JSON.stringify(new URL('../src/gate.js', import.meta.url).href)};
import * as store from ${JSON.stringify(new URL('../src/board.js', import.meta.url).href)};
import {readGateReceipt,receiptStore} from ${JSON.stringify(new URL('../src/gate-run-receipt.js', import.meta.url).href)};
import {readFileSync} from 'node:fs';
const root=process.cwd(); const run=await runGate(root,JSON.parse(readFileSync('pullboard.json','utf8')),{trustStamp:false,landing:true,collectAll:true,auditBatchId:${JSON.stringify(batchId)},agent:'coordinator'});
const receipt=readGateReceipt(receiptStore(root),run.receiptId); if(!receipt?.collection?.complete||!receipt.collection.full)throw new Error(run.output);
const db=store.openBoard('.git/pullboard/board.sqlite',undefined,{isMain:true});try{store.recordGateRun(db,{agentId:'coordinator',receipt,lane:'web'});}finally{store.closeBoard(db);}console.log(receipt.id);`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test('train receipt enforcement is opt-in and validates its boolean configuration [C7]', () => {
  assert.notEqual(configFromSource('{}').landing?.requireReceipts, true);
  for (const value of [false, true]) assert.equal(configFromSource(JSON.stringify({ landing: { requireReceipts: value } })).landing.requireReceipts, value);
  for (const value of [null, 1, 'true']) assert.throws(() => configFromSource(JSON.stringify({ landing: { requireReceipts: value } })), { code: 'BAD_CONFIG' });
  const migration = { base: 'a'.repeat(40), side: 'b'.repeat(40) };
  const message = `chore: retain published source\n\nPullboard-Migration: ${migration.base}\n`;
  assert.deepEqual(prepareCommitMetadata(message, { syncMerge: true, migration }).problems, []);
  for (const context of [{}, { syncMerge: true }, { migration },
    { syncMerge: true, migration: { ...migration, side: migration.base } },
    { syncMerge: true, migration: { ...migration, base: 'c'.repeat(40) } }]) {
    assert.ok(prepareCommitMetadata(message, context).problems.length, 'a migration trailer needs its actual authorized merge context');
  }
});

test('default-off merged remains compatible while an explicitly supplied receipt is always checked [C7]', t => {
  const box = fixture(t, false);
  const id = verifiedItem(box, 1);
  const invalid = box.run(box.repo, 'merged', String(id), 'HEAD', '--gate-receipt', randomUUID(), '--json');
  assert.equal(invalid.code, 1, invalid.out);
  assert.equal(JSON.parse(invalid.out).error.code, 'LAND_RECEIPT_UNBOUND');
  assert.equal(onBoard(box, board => store.getItem(board, id).item_merged_commit), null);
  const legacy = box.run(box.repo, 'merged', String(id), 'HEAD', '--json');
  assert.equal(legacy.code, 0, `${legacy.out}${legacy.err}`);
  assert.equal(onBoard(box, board => store.landingBatches(board).length), 0);
});

test('one real native envelope covers multiple reviewed sources and only its first-parent commit needs a receipt [C7,B3]', async t => {
  process.stderr.write('train envelope phase: fixture setup\n');
  const box = fixture(t);
  process.stderr.write('train envelope phase: fixture ready\n');
  box.git(box.repo, 'checkout', '--detach', box.base);
  const ids = [verifiedItem(box, 1), verifiedItem(box, 2)];
  process.stderr.write('train envelope phase: reviewed sources ready\n');
  const side = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const options = { base: box.base, side,
    items: onBoard(box, board => ids.map(id => ({ id, commit: store.getItem(board, id).item_commit }))),
    message: `chore: retain the actual multi-item envelope\n\nPullboard-Migration: ${box.base}` };
  const made = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    `import {createLandingEnvelope} from ${JSON.stringify(new URL('../src/landing-envelope.js', import.meta.url).href)}; console.log(JSON.stringify(createLandingEnvelope(process.cwd(),${JSON.stringify(options)})));`],
  { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  const envelope = JSON.parse(made.stdout);
  process.stderr.write('train envelope phase: envelope created\n');
  box.git(box.repo, 'checkout', 'main');
  box.git(box.repo, 'merge', '--ff-only', envelope.tip);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^1').trim(), box.base);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^2').trim(), side);
  process.stderr.write('train envelope phase: native landing gate start\n');
  const receipt = gate(box);
  process.stderr.write('train envelope phase: native landing gate returned\n');
  const landed = box.run(box.repo, 'merged', String(ids[0]), envelope.tip,
    '--items', ids.join(','), '--gate-receipt', receipt.id, '--json');
  // Preserve a native refusal before asynchronous fixture audit cleanup can delay its failed assertion.
  if (landed.code !== 0) {
    let refusal;
    try { refusal = JSON.parse(landed.out).error; } catch { refusal = landed.out.slice(0, 12000); }
    process.stderr.write(safeFixtureDiagnostic(`train envelope merged refusal: ${JSON.stringify({ code: landed.code, refusal, stderr: landed.err.slice(0, 12000) })}\n`, box.env));
  }
  process.stderr.write('train envelope phase: merged returned\n');
  assert.equal(landed.code, 0, `${landed.out}${landed.err}`);
  const batch = JSON.parse(landed.out).batch;
  assert.deepEqual(onBoard(box, board => store.landingBatches(board)[0].migration),
    { version: 1, publishedBase: box.base, side, tip: envelope.tip });
  assert.deepEqual(onBoard(box, board => ids.map(id => store.getItem(board, id).item_merged_commit)), ids.map(() => envelope.tip));
  const range = pushedFirstParentCommits(box.repo, `refs/heads/main ${envelope.tip} refs/heads/main ${box.base}\n`);
  assert.deepEqual(range, [envelope.tip]);
  process.stderr.write('train envelope phase: audit start\n');
  await audit(box, batch);
  process.stderr.write('train envelope phase: audit returned\n');
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, range)), []);
});

test('native land retains one batch identity and records its actual envelope receipt before merged events [C7,B3]', async t => {
  const box = fixture(t);
  box.git(box.repo, 'checkout', '--detach', box.base);
  const ids = [verifiedItem(box, 1), verifiedItem(box, 2)];
  box.git(box.repo, 'checkout', 'main');
  const landed = box.run(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, `${landed.out}${landed.err}`);
  const batch = JSON.parse(landed.out).batch;
  assert.equal(batch.state, 'landed');
  assert.deepEqual(batch.items.map(entry => entry.id), ids);
  assert.ok(batch.proof.receipt.id);
  assert.equal(batch.proof.receipt.head, batch.tip);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^1').trim(), box.base);
  assert.equal(onBoard(box, board => store.landingBatches(board).length), 1, 'no orphan native UUID or duplicate train batch');
  assert.deepEqual(onBoard(box, board => ids.map(id => store.getItem(board, id).item_merged_commit)), ids.map(() => batch.tip));
  const rows = onBoard(box, board => store.events(board));
  const produced = rows.find(row => row.event_kind === 'gate-run' && JSON.parse(row.event_detail).run.id === batch.proof.receipt.id);
  const merged = rows.filter(row => row.event_kind === 'merged' && ids.includes(row.item_id));
  assert.equal(merged.length, 2);
  assert.ok(merged.every(row => produced.event_id < row.event_id));
  await audit(box, batch.id);
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, [batch.tip])), []);
  box.git(box.repo, 'checkout', '--detach', batch.tip);
  const nextId = verifiedItem(box, 3);
  box.git(box.repo, 'checkout', 'main');
  const next = box.run(box.repo, 'land', '--json');
  assert.equal(next.code, 0, `${next.out}${next.err}`);
  const following = JSON.parse(next.out).batch;
  assert.notEqual(following.id, batch.id);
  assert.notEqual(following.proof.receipt.id, batch.proof.receipt.id);
  assert.equal(following.base, batch.tip);
  assert.equal(onBoard(box, board => store.getItem(board, nextId).item_merged_commit), following.tip);
  assert.equal(onBoard(box, board => store.landingBatches(board).length), 2);
  await audit(box, following.id);
  const range = pushedFirstParentCommits(box.repo, `refs/heads/main ${following.tip} refs/heads/main ${box.base}\n`);
  assert.deepEqual(range, [batch.tip, following.tip]);
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, range)), []);
});

test('a required train landing refuses missing, mismatched and red native receipts before any merged event [C7]', t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const before = onBoard(box, board => store.getItem(board, id));
  const missing = box.run(box.repo, 'merged', String(id), 'HEAD', '--json');
  assert.equal(missing.code, 1, missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'LAND_RECEIPT_REQUIRED');
  assert.deepEqual(onBoard(box, board => store.getItem(board, id)), before);
  const green = gate(box);
  const red = gate(box, true);
  for (const receipt of [red, { id: randomUUID() }]) {
    const result = box.run(box.repo, 'merged', String(id), 'HEAD', '--gate-receipt', receipt.id, '--json');
    assert.equal(result.code, 1, result.out);
    assert.equal(JSON.parse(result.out).error.code, 'LAND_RECEIPT_UNBOUND');
  }
  const old = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(box.repo, 'web/later.txt'), 'different committed source\n');
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: change native receipt source');
  const mismatch = box.run(box.repo, 'merged', String(id), 'HEAD', '--gate-receipt', green.id, '--json');
  assert.equal(mismatch.code, 1, mismatch.out);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD').trim(), old);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_merged_commit), null);
});

test('a native train landing records ordered bound evidence and an audit permits only the landed push range [C7]', async t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const receipt = gate(box);
  const second = gate(box);
  assert.notEqual(second.id, receipt.id, 'explicit receipt production never reuses a tree stamp');
  const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  assert.match(onBoard(box, board => nativePushReceiptProblems(box.repo, board, [tip])).join('\n'), /audit/u);
  const landed = box.run(box.repo, 'merged', String(id), tip, '--gate-receipt', receipt.id, '--json');
  assert.equal(landed.code, 0, `${landed.out}${landed.err}`);
  const value = JSON.parse(landed.out);
  const rows = onBoard(box, board => store.events(board));
  const gateEvent = rows.find(row => row.event_kind === 'gate-run' && JSON.parse(row.event_detail).run.id === receipt.id);
  const batchEvent = rows.find(row => row.event_kind === 'landing_batch' && JSON.parse(row.event_detail).batch.state === 'landed');
  assert.ok(gateEvent.event_id < batchEvent.event_id);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_merged_commit), tip);
  await audit(box, value.batch);
  const range = pushedFirstParentCommits(box.repo, `refs/heads/main ${tip} refs/heads/main ${box.base}\n`);
  assert.deepEqual(range, [tip]);
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, range)), []);
  const positive = runFixtureChild(process.execPath, [join(box.repo, 'bin/pullboard.js'), 'push-receipts', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8',
      input: `refs/heads/main ${tip} refs/heads/main ${box.base}\n` });
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  const allowed = JSON.parse(positive.stdout);
  assert.equal(allowed.green, true, 'the public CLI accepts the actual native landed range');
  assert.deepEqual(allowed.commits, [tip]);
  assert.equal(allowed.activated, false, 'the additive command never replaces the active hook');
  writeFileSync(join(box.repo, 'web/hand-made.txt'), 'bypassed train\n');
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: bypass the native train');
  const bypass = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  assert.match(onBoard(box, board => nativePushReceiptProblems(box.repo, board, [tip, bypass])).join('\n'), /lacks its exact native green landing receipt/u);
  const negative = runFixtureChild(process.execPath, [join(box.repo, 'bin/pullboard.js'), 'push-receipts', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8',
      input: `refs/heads/main ${bypass} refs/heads/main ${box.base}\n` });
  assert.equal(negative.status, 1, `${negative.stdout}${negative.stderr}`);
  const refused = JSON.parse(negative.stdout);
  assert.equal(refused.green, false);
  assert.ok(refused.problems.some(problem => problem.includes(bypass)
    && problem.includes('exact native green landing receipt')),
  'the public CLI rejects the real handmade commit for its missing receipt');
});


test('native train evidence seals at origin and replays without private receipt files while tampering refuses [C7,H16]', t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const receipt = gate(box);
  const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  // Only acceptance is synthetic lifecycle setup; the Git source, SQLite prefix and gate receipt are real.
  onBoard(box, origin => {
    const request = prepareTrainLanding(box.repo, origin, [id], tip, receipt.id);
    const before = store.events(origin).length;
    assert.throws(() => store.recordTrainLanding(origin, { ...request,
      receipt: { ...receipt, command: '0'.repeat(64) } }), { code: 'GATE_RUN_UNBOUND' });
    assert.equal(store.events(origin).length, before, 'unbound direct writer emits no partial gate or landing');
    const move = prepareEngineMove(origin, 'recordTrainLanding', [request]);
    assert.deepEqual(move.args[0].receipt, receipt, 'origin seals the producer bytes, not caller receipt assertions');
    const copy = join(box.dir, 'train-replica.sqlite');
    origin.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    // @pullboard-board-file persistence: replay the copied SQLite replica without the origin receipt sidecar
    const replica = store.openBoard(copy, undefined, { isMain: true });
    try {
      assert.equal(readGateReceipt(boardReceiptStore(replica), receipt.id), null,
        'the replica has the native SQLite prefix but no origin private receipt file');
      const sequence = appliedSequence(replica) + 1;
      const at = new Date().toISOString();
      assert.throws(() => applyEngineMove(replica, { ...move, engine: TRAIN_LANDING_ENGINE - 1 }, { sequence, at }),
        { code: 'RELAY_MOVE' });
      assert.equal(appliedSequence(replica), sequence - 1, 'an older engine cannot silently drop landing proof');
      const bad = { ...move, id: randomUUID(), args: [{ ...move.args[0],
        receipt: { ...move.args[0].receipt, head: box.base } }] };
      const refused = applyEngineMove(replica, bad, { sequence, at });
      assert.equal(refused.error?.code, 'LAND_RECEIPT_UNBOUND');
      assert.equal(store.getItem(replica, id).item_merged_commit, null);
      assert.equal(store.events(replica).length, before, 'tampered replay rolls back every product event');
      const validSequence = sequence + 1;
      const applied = applyEngineMove(replica, move, { sequence: validSequence, at });
      assert.equal(applied.error, undefined);
      assert.equal(store.getItem(replica, id).item_merged_commit, tip);
      assert.deepEqual(store.landingBatches(replica).find(batch => batch.id === `train-${receipt.id}`).proof.receipt, receipt);
      const count = store.events(replica).length;
      assert.deepEqual(applyEngineMove(replica, move, { sequence: validSequence, at }), applied);
      assert.equal(store.events(replica).length, count, 'identical sealed replay adds no duplicate events');
      assert.throws(() => applyEngineMove(replica, { ...move, args: bad.args }, { sequence: validSequence, at }),
        { code: 'RELAY_MOVE' }, 'a recorded MOVEID cannot be reused with altered bytes');
    } finally { store.closeBoard(replica); }
  });
});

test('a remote-only native train proof refuses dirty source before any local test body [C7]', t => {
  const box = fixture(t);
  const marker = join(box.dir, 'actual-gate-body-ran');
  const file = join(box.repo, 'web/train.test.js');
  writeFileSync(file, readFileSync(file, 'utf8') + `\nimport {writeFileSync} from 'node:fs';
test('actual admission sentinel [C7]',()=>writeFileSync(${JSON.stringify(marker)},'ran'));\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: mark the actual private gate body');
  writeFileSync(join(box.repo, 'web/dirty-proof.txt'), 'A remote proof needs committed source.\n');
  const source = `import {runGate} from ${JSON.stringify(new URL('../src/gate.js', import.meta.url).href)};
import {readFileSync} from 'node:fs';
try {await runGate(process.cwd(),JSON.parse(readFileSync('pullboard.json','utf8')),{trustStamp:false,runnerOnly:true});
console.log(JSON.stringify({unexpectedExecution:true}));}
catch(error){console.log(JSON.stringify({code:error.code,message:error.message}));}`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const value = JSON.parse(result.stdout);
  const executed = existsSync(marker);
  assert.equal(value.code, 'RUNNER_SOURCE', JSON.stringify({ value, executed }));
  assert.equal(executed, false, 'remote-only proof refusal never executes the local gate body');
});
