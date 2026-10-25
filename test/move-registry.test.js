/** @pullboard-test-input source-tree */
/** @pullboard-test-input test-tree */
/** @pullboard-test-loads src/move-registry.js src/moves/*.js */
/** Move-only registry discovery preserves a pinned historical resolution and real replay [C7,V4,H3,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { unpackRelease } from './release-archive.js';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, ENGINE_OPERATIONS } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { MOVE_REGISTRY } from '../src/move-registry.js';
import { PROOF_RUN_ENGINE } from '../src/proof-run-engine.js';
import { relayMoveActor } from '../src/relay-sender.js';
import { NEXT_STEPS } from '../src/next-step-words.js';
import { REGISTRY_AT, registryFixtureBoard } from './move-registry-fixture.js';
import { importsIn } from '../src/module-imports.js';
import { readdirSync } from 'node:fs';
import { minimumMoveEngine } from '../src/move-registry.js';
import { SPEC_REVISION_ENGINE } from '../src/spec-revision-engine.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('./move-registry-baseline.json', import.meta.url), 'utf8'));
const CONSUMERS = ['src/engine.js', 'src/relay-sender.js', 'src/next-step-words.js'];

/** Hash the real consumer bytes so seed declarations cannot quietly edit a central list. */
function consumerHashes(root) {
  return Object.fromEntries(CONSUMERS.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
}

/** Run one fixture child, preserving both streams whenever setup or discovery fails. */
function run(root, command, args) {
  const result = runFixtureChild(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** One independent feature file declares all four routing dimensions without a shared edit. */
function seedDeclaration(name, engine, itemIdFirstArgument, step) {
  return `/** Independent fixture board move [C7,V4]. */
/** Preserve this fixture move's explicit engine floor. */
function minimumEngine() { return ${engine}; }
/** Read the fixture actor from exactly its declared argument. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default { operation: ${JSON.stringify(name)}, order: ${engine + 1000}, engine: ${engine}, minimumEngine,
  itemIdFirstArgument: ${itemIdFirstArgument}, actor, nextSteps: { ${JSON.stringify(name.toUpperCase())}: ${JSON.stringify(step)} } };
`;
}

test('today\'s move order, actors, refusal recovery text and recorded SQLite prefix are unchanged [C7,V4,H3,H16]', t => {
  assert.deepEqual(ENGINE_OPERATIONS, SNAPSHOT.operations);
  assert.deepEqual(NEXT_STEPS, SNAPSHOT.nextSteps);
  assert.equal(minimumMoveEngine('recordProofRun', [{ landingFence: {}, receipt: { environment: {} } }, { cause: 'conflict:new' }]), PROOF_RUN_ENGINE);
  assert.equal(MOVE_REGISTRY.recordProofRun.engine, PROOF_RUN_ENGINE);
  assert.equal(MOVE_REGISTRY.recordProofRun.itemIdFirstArgument, false);
  assert.equal(relayMoveActor({ operation: 'recordProofRun', args: [{ agentId: 'proof-seat' }] }), 'proof-seat');
  assert.equal(relayMoveActor({ operation: 'recordProofRun', args: [] }), null);
  for (const operation of SNAPSHOT.operations) {
    assert.deepEqual(SNAPSHOT.actorVectors.map(vector => relayMoveActor({ operation, ...vector })), SNAPSHOT.actors[operation], operation);
  }
  assert.equal(relayMoveActor({ operation: 'toString', args: [] }), null, 'object prototype names are not moves');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-replay-'));
  const board = store.openBoard(join(directory, 'replica.sqlite'), { now: () => new Date(REGISTRY_AT) });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  importBoard(board, SNAPSHOT.replay.initial);
  for (const { move, options, outcome } of SNAPSHOT.replay.records) {
    assert.deepEqual(applyEngineMove(board, move, options), outcome, move.operation);
    assert.deepEqual(applyEngineMove(board, move, options), outcome, 'same-position retry returns its immutable receipt');
  }
  const replay = exportBoard(board);
  const acceptedExpected = SNAPSHOT.replay.acceptedExpected;
  const engineRows = acceptedExpected.tables.board_meta.filter(row => row.meta_key === 'relay_engine_version');
  assert.equal(engineRows.length, 1, 'the accepted snapshot has one receiver engine-version field');
  assert.equal(engineRows[0].meta_value, '107', 'the historical golden retains its original writer engine');
  for (const { move } of SNAPSHOT.replay.records) {
    const key = `relay_receipt_${move.id}`;
    const expected = acceptedExpected.tables.board_meta.find(row => row.meta_key === key);
    const actual = replay.tables.board_meta.find(row => row.meta_key === key);
    assert.ok(expected, `${key} is part of the immutable accepted snapshot`);
    assert.equal(actual?.meta_value, expected.meta_value, `${key} retains its exact historical bytes`);
  }
  // Receiver capability advances with this engine; the historical move receipts stay pinned above.
  const replayExpected = {
    ...acceptedExpected,
    tables: {
      ...acceptedExpected.tables,
      board_meta: acceptedExpected.tables.board_meta.map(row => row.meta_key === 'relay_engine_version'
        ? { ...row, meta_value: String(ENGINE_VERSION) }
        : row),
    },
  };
  assert.equal(JSON.stringify(replay), JSON.stringify(replayExpected), 'items, events, receipts and replay cursor retain accepted-main bytes for the exact historical moves');
});

test('two new board moves declared in two files need no edit to engine.js, relay-sender.js or next-step-words.js [C7,V4,H3,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  unpackRelease('HEAD', root);
  run(root, 'git', ['init', '-b', 'main']);
  const before = consumerHashes(root);
  mkdirSync(join(root, 'src/moves'), { recursive: true });
  writeFileSync(join(root, 'src/moves/seedAlpha.js'), seedDeclaration('seedAlpha', 9, true, 'repair the first seeded move'));
  writeFileSync(join(root, 'src/moves/seedBeta.js'), seedDeclaration('seedBeta', 11, false, 'repair the second seeded move'));
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '-m', 'fixture: two independent declarations']);
  const child = `
import {ENGINE_OPERATIONS} from './src/engine.js';
import {relayMoveActor} from './src/relay-sender.js';
import {NEXT_STEPS} from './src/next-step-words.js';
import {readFileSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import * as store from './src/board.js';
import {registryFixtureBoard,REGISTRY_AT} from './test/move-registry-fixture.js';
const root=process.cwd();
const result={operations:ENGINE_OPERATIONS,alphaActor:relayMoveActor({operation:'seedAlpha',args:[7,{agentId:'seed-agent'}]}),
  alphaStep:NEXT_STEPS.SEEDALPHA,betaStep:NEXT_STEPS.SEEDBETA};
if(ENGINE_OPERATIONS.includes('seedAlpha')&&ENGINE_OPERATIONS.includes('seedBeta')) {
  const {MOVE_REGISTRY,minimumMoveEngine,discoverMoves}=await import('./src/move-registry.js');
  const {importsIn}=await import('./src/module-imports.js');
  const snapshot=JSON.parse(readFileSync('./test/move-registry-baseline.json','utf8'));
  const boards=new Map();
  try {
    const forbidden=new Set(['src/board.js','src/engine.js','src/relay-sender.js','src/next-step-words.js','src/move-registry.js','src/git.js']);
    const seen=new Set();
    let pending=readdirSync('./src/moves').filter(file=>file.endsWith('.js')).map(file=>pathToFileURL(join(root,'src/moves',file)).href);
    while(pending.length) {
      const level=[...new Set(pending)].filter(file=>!seen.has(file));pending=[];
      for(const file of level) {
        const relative=fileURLToPath(file).slice(root.length+1);
        if(forbidden.has(relative))throw Error('move declarations load a forbidden writer/consumer '+relative);
        seen.add(file);
      }
      const edges=importsIn(level.map(file=>readFileSync(fileURLToPath(file),'utf8')));
      for(const [index,imports] of edges.entries())for(const specifier of imports) {
        if(specifier==='node:child_process')throw Error('move declarations load a process launcher');
        if(specifier.startsWith('node:'))continue;
        if(!specifier.startsWith('.'))throw Error('unknown move import '+specifier);
        pending.push(new URL(specifier,level[index]).href);
      }
    }
    result.pureImportClosure=true;
    result.itemIds=Object.values(MOVE_REGISTRY).filter(move=>move.itemIdFirstArgument).map(move=>move.operation);
    result.floors=snapshot.floorCases.map(entry=>{
      if(entry.state&&!boards.has(entry.state))boards.set(entry.state,registryFixtureBoard(root,entry.state));
      return minimumMoveEngine(entry.operation,entry.args,entry.state?boards.get(entry.state):undefined,new Date(REGISTRY_AT));
    });
    result.seedFloors=[minimumMoveEngine('seedAlpha',[]),minimumMoveEngine('seedBeta',[])];
    result.refusals=[];
    const invalidCases=[['bad name.js', ${JSON.stringify(seedDeclaration('badName', 1, false, 'fix'))}],
      ['wrongName.js',${JSON.stringify(seedDeclaration('differentName', 1, false, 'fix'))}],
      ['zeroFloor.js',${JSON.stringify(seedDeclaration('zeroFloor', 0, false, 'fix'))}]];
    for(const [index,[file,source]] of invalidCases.entries()) {
      const folder=join(root,'invalid-'+index);mkdirSync(folder);writeFileSync(join(folder,file),source);
      try {await discoverMoves(pathToFileURL(folder+'/'));result.refusals.push(false);}catch{result.refusals.push(true);}
    }
    const conflict=join(root,'conflicting-steps');mkdirSync(conflict);
    writeFileSync(join(conflict,'first.js'),${JSON.stringify(seedDeclaration('first', 1, false, 'first').replace('FIRST:', 'SHARED:'))}.replace('"FIRST"','"SHARED"'));
    writeFileSync(join(conflict,'second.js'),${JSON.stringify(seedDeclaration('second', 2, false, 'second'))}.replace('"SECOND"','"SHARED"'));
    try {await discoverMoves(pathToFileURL(conflict+'/'));result.conflictingStepRefused=false;}catch{result.conflictingStepRefused=true;}
  } finally {for(const board of boards.values())store.closeBoard(board);}
}
process.stdout.write(JSON.stringify(result));`;
  const result = JSON.parse(run(root, process.execPath, ['--input-type=module', '-e', child]));
  assert.ok(result.operations.includes('seedAlpha'), 'the first independent operation file is discovered');
  assert.ok(result.operations.includes('seedBeta'), 'the second independent operation file is discovered');
  assert.deepEqual(result.operations.filter(name => !name.startsWith('seed')), SNAPSHOT.operations, 'existing order does not move');
  assert.deepEqual(result.seedFloors, [9, 11]);
  assert.equal(result.pureImportClosure, true, 'routing metadata never imports its consumers, board writers or Git/process launchers');
  assert.equal(result.alphaActor, 'seed-agent');
  assert.equal(result.alphaStep, 'repair the first seeded move');
  assert.equal(result.betaStep, 'repair the second seeded move');
  assert.deepEqual(result.itemIds.filter(name => !name.startsWith('seed')).sort(), [...SNAPSHOT.itemIdFirstArgument].sort());
  assert.ok(result.itemIds.includes('seedAlpha'));
  assert.ok(!result.itemIds.includes('seedBeta'));
  assert.deepEqual(result.floors, SNAPSHOT.floorCases.map(entry => entry.expected), 'all historical first-match floor vectors retain their results');
  assert.deepEqual(result.refusals, [true, true, true], 'bad names, mismatched identities and invalid floors fail closed');
  assert.equal(result.conflictingStepRefused, true, 'two declarations cannot silently disagree about recovery guidance');
  assert.deepEqual(consumerHashes(root), before, 'the three central consumers were never edited to add either move');
});


test('move import closure stays process-free on a seeded revision board [C7,V4,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-move-closure-'));
  const board = registryFixtureBoard(directory, 'revision-closure');
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  // Private reader input: floor selection must inspect the recorded revision rather than spawn.
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('row_decisions',
    JSON.stringify([{ event: 7, revision: { source: 'private recorded revision fixture' } }]));
  assert.equal(minimumMoveEngine('applyRowDecisions', [{ events: [7] }], board), SPEC_REVISION_ENGINE);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const forbidden = new Set(['src/board.js', 'src/engine.js', 'src/relay-sender.js', 'src/next-step-words.js', 'src/move-registry.js', 'src/git.js']);
  const seen = new Set();
  let pending = readdirSync(join(root, 'src/moves')).filter(file => file.endsWith('.js'))
    .map(file => pathToFileURL(join(root, 'src/moves', file)).href);
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !seen.has(file));
    pending = [];
    for (const file of level) {
      assert.ok(!forbidden.has(fileURLToPath(file).slice(root.length)), 'move declarations load no writer/consumer');
      seen.add(file);
    }
    const edges = importsIn(level.map(file => readFileSync(fileURLToPath(file), 'utf8')));
    for (const [index, imports] of edges.entries()) for (const specifier of imports) {
      assert.notEqual(specifier, 'node:child_process', 'move declarations load no process launcher');
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), 'move imports are native or relative');
      pending.push(new URL(specifier, level[index]).href);
    }
  }
});
