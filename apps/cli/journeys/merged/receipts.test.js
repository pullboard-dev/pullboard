/** @pullboard-test-input source-tree */
/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import { recordTrainLanding } from '../../../../packages/landing/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { boardReceiptStore } from '../../../../packages/gate/index.js';
import { readGateReceipt } from '../../../../packages/gate/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { prepareTrainLanding } from '../../../../packages/landing/index.js';
import { TRAIN_LANDING_ENGINE } from '../../../../packages/state/light.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { prepareCommitMetadata } from '../../../../packages/commits/index.js';
import { fixture } from '../../tests/fixtures/landing/receipts.js';
import { verifiedItem } from '../../tests/fixtures/landing/receipts.js';
import { gate } from '../../tests/fixtures/landing/receipts.js';
import { onBoard } from '../../tests/fixtures/landing/receipts.js';

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

test('native train evidence seals at origin and replays without private receipt files while tampering refuses [C7,H16]', t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const receipt = gate(box);
  const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  // Only acceptance is synthetic lifecycle setup; the Git source, SQLite prefix and gate receipt are real.
  onBoard(box, origin => {
    const request = prepareTrainLanding(box.repo, origin, [id], tip, receipt.id);
    const before = store.events(origin).length;
    assert.throws(() => recordTrainLanding(origin, { ...request,
      receipt: { ...receipt, command: '0'.repeat(64) } }), { code: 'GATE_RUN_UNBOUND' });
    assert.equal(store.events(origin).length, before, 'unbound direct writer emits no partial gate or landing');
    const move = prepareEngineMove(origin, 'recordTrainLanding', [request]);
    assert.deepEqual(move.args[0].receipt, receipt, 'origin seals the producer bytes, not caller receipt assertions');
    const copy = join(box.dir, 'train-replica.sqlite');
    origin.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    // @pullboard-board-file persistence: replay the copied SQLite replica without the origin receipt sidecar
    const replica = openBoard(copy, undefined, { isMain: true });
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
  writeFileSync(file, readFileSync(file, 'utf8') + `\nimport { writeFileSync } from 'node:fs';
test('actual admission sentinel [C7]',()=>writeFileSync(${JSON.stringify(marker)},'ran'));\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: mark the actual private gate body');
  writeFileSync(join(box.repo, 'web/dirty-proof.txt'), 'A remote proof needs committed source.\n');
  const source = `import {runGate} from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
import { runnerExecutionServices } from ${JSON.stringify(new URL('../../../../packages/runners/index.js', import.meta.url).href)};
import { landingExecutionServices } from ${JSON.stringify(new URL('../../../../packages/landing/index.js', import.meta.url).href)};
import { readFileSync } from 'node:fs';
try {await runGate(process.cwd(),JSON.parse(readFileSync('pullboard.json','utf8')),{executionServices:{runners:runnerExecutionServices(),landing:landingExecutionServices()},trustStamp:false,runnerOnly:true});
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
