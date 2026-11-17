/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/cli/tests/fixtures/move/registry/baseline.json packages/state/data/history/** */
/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js */
/** Move-only registry discovery preserves a pinned historical resolution and real replay [C7,V4,H3,H16]. */
import { installStaleStateRegistryCases } from '../../tests/fixtures/cases/registry.js';
import '../../../lib/tests/registry.test.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { unpackRelease } from '../../../../packages/gate/tests/fixtures/release/archive.js';
import * as store from '../../../../packages/store/index.js';
import {
  openBoard,
  nativeBoardPorts,
} from '../../../lib/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { MOVE_OPERATIONS as ENGINE_OPERATIONS } from '../../../../packages/moves/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { MOVE_REGISTRY } from '../../../../packages/moves/index.js';
import { PROOF_RUN_ENGINE } from '../../../../packages/state/light.js';
const { relayMoveActor } = nativeBoardPorts().enginePorts;
import { NEXT_STEPS } from '../../index.js';
import { REGISTRY_AT } from '../../tests/fixtures/move/registry.js';
import { registryFixtureBoard } from '../../tests/fixtures/move/registry.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { readdirSync } from 'node:fs';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { SPEC_REVISION_ENGINE } from '../../../../packages/state/light.js';
import { PRIVATE_REHOME_ENGINE } from '../../../../packages/state/light.js';
import { registryProblems } from '../../tests/fixtures/move/registry/invariants.js';
import {
  mappedWorkingSources,
} from '../../../../packages/gate/src/io/scan.js';
import { readPathMap } from '../../../../packages/codemap/index.js';
import {
  ENGINE_FOLDER,
  readEngineLeaves,
} from '../../../../packages/state/src/io/engine/numbers.js';
import { historyProblems } from '../../tests/fixtures/move/registry/history.js';
import { installRegistryMergeCase } from '../../tests/fixtures/move/registry/cases.js';
import { TRAIN_LANDING_ENGINE } from '../../../../packages/state/light.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../../tests/fixtures/move/registry/baseline.json', import.meta.url), 'utf8'));
const CONSUMERS = ['src/engine.js', 'src/board-engine-ports.js', 'src/next-step-words.js'];
const CLAUSE_STEPS = Object.freeze({
  BAR_CLAUSE_REQUIRED: 'add --clause "exact wording from the frozen criterion or spec row"',
  BAR_CLAUSE_UNKNOWN: 'read pullboard show <id>, then quote the failing requirement with --clause',
  BAD_DECISION: 'choose accept or reject with a supported reason: pullboard verify <id> reject --reason TEST_FAILURE --clause "<frozen wording>" --note "<what failed>"',
  CHECK_RED: 'reject with what failed: pullboard verify <id> reject --reason TEST_FAILURE --clause "<frozen wording>" --note "<what failed>"',
  GUARD_CANNOT_FAIL: 'reject: the check does not test the guard; ask for one that fails with the guard reverted: pullboard verify <id> reject --reason TEST_FAILURE --clause "<frozen wording>" --note "<what the check missed>"',
});
const REHOME_OPERATIONS = ['reserveRehomeItemId', 'rehomeItem', 'applyRehomeItem'];

/** Hash the real consumer bytes so seed declarations cannot quietly edit a central list. */
function consumerHashes(root) {
  return Object.fromEntries(mappedWorkingSources(root, CONSUMERS).map(input => [input.identity, {
    body: createHash('sha256').update(input.body).digest('hex'),
    shim: input.shimBody === null ? null : createHash('sha256').update(input.shimBody).digest('hex'),
  }]));
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

test('cli.journeys-move-registry.live-registry-invariants-and-historical-actors: live registry invariants and historical actors, order and SQLite replay hold [C7,V4,H3,H16]', t => {
  assert.deepEqual(ENGINE_OPERATIONS.filter(operation => SNAPSHOT.operations.includes(operation)), SNAPSHOT.operations, 'historical operation order is retained while new declarations append independently');
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  // The old src/ files are named by the committed map, which points each at the cell or app file that holds it now.
  const identities = new Set();
  for (const [identity] of readPathMap(repository)) if (identity.startsWith('src/') && identity.endsWith('.js')) identities.add(identity);
  const sources = mappedWorkingSources(repository, [...identities])
    .flatMap(input => [input.body, ...(input.shimBody === null ? [] : [input.shimBody])]).map(bytes => bytes.toString('utf8'));
  assert.deepEqual(registryProblems({ registry: MOVE_REGISTRY, leaves: readEngineLeaves(join(repository, ENGINE_FOLDER)), sources, nextSteps: NEXT_STEPS }), []);
  assert.deepEqual(ENGINE_OPERATIONS, Object.keys(MOVE_REGISTRY), 'engine routing derives every operation from its declaration');
  for (const [code, step] of Object.entries(CLAUSE_STEPS)) assert.equal(NEXT_STEPS[code], step, `${code} retains exact clause recovery`);
  assert.equal(minimumMoveEngine('recordProofRun', [{ landingFence: {}, receipt: { environment: {} } }, { cause: 'conflict:new' }]), PROOF_RUN_ENGINE);
  assert.equal(MOVE_REGISTRY.recordProofRun.engine, PROOF_RUN_ENGINE);
  assert.equal(MOVE_REGISTRY.recordProofRun.itemIdFirstArgument, false);
  assert.equal(relayMoveActor({ operation: 'recordProofRun', args: [{ agentId: 'proof-seat' }] }), 'proof-seat');
  assert.equal(relayMoveActor({ operation: 'recordProofRun', args: [] }), null);
  for (const operation of SNAPSHOT.operations) {
    assert.equal(MOVE_REGISTRY[operation].itemIdFirstArgument, SNAPSHOT.itemIdFirstArgument.includes(operation), `${operation} retains its exact historical slot flag`);
    assert.deepEqual(SNAPSHOT.actorVectors.map(vector => relayMoveActor({ operation, ...vector })), SNAPSHOT.actors[operation], operation);
  }
  assert.equal(relayMoveActor({ operation: 'reserveRehomeItemId', args: ['0'.repeat(32), 'move-1', { agentId: 'destination' }] }), 'destination');
  assert.equal(relayMoveActor({ operation: 'rehomeItem', args: [1, { agentId: 'source' }] }), 'source');
  assert.equal(relayMoveActor({ operation: 'applyRehomeItem', args: [{}, { destinationAgentId: 'destination' }] }), 'destination');
  for (const operation of REHOME_OPERATIONS) assert.equal(minimumMoveEngine(operation, []), PRIVATE_REHOME_ENGINE, `${operation} uses the declared re-home floor`);
  assert.equal(ENGINE_OPERATIONS.filter(operation => operation === 'recordTrainLanding').length, 1);
  assert.equal(MOVE_REGISTRY.recordTrainLanding.engine, TRAIN_LANDING_ENGINE);
  assert.equal(MOVE_REGISTRY.recordTrainLanding.itemIdFirstArgument, false);
  assert.equal(minimumMoveEngine('recordTrainLanding', []), TRAIN_LANDING_ENGINE);
  assert.equal(relayMoveActor({ operation: 'recordTrainLanding', args: [{ agentId: 'coordinator' }] }), 'coordinator');
  assert.equal(relayMoveActor({ operation: 'recordTrainLanding', args: [{}, { agentId: 'wrong-position' }] }), null);
  assert.equal(relayMoveActor({ operation: 'recordTrainLanding', args: [] }), null);
  assert.equal(relayMoveActor({ operation: 'toString', args: [] }), null, 'object prototype names are not moves');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-replay-'));
  const board = openBoard(join(directory, 'replica.sqlite'), { now: () => new Date(REGISTRY_AT) });
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

test('cli.journeys-move-registry.two-new-board-moves-declared-in: two new board moves declared in two files need no edit to engine.js, board-engine-ports.js or next-step-words.js [C7,V4,H3,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  unpackRelease('HEAD', root);
  run(root, 'git', ['init', '-b', 'main']);
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '-m', 'fixture: exact installed source map']);
  const before = consumerHashes(root);
  mkdirSync(join(root, 'packages/moves/src/logic/moves'), { recursive: true });
  writeFileSync(join(root, 'packages/moves/src/logic/moves/seedAlpha.js'), seedDeclaration('seedAlpha', 9, true, 'repair the first seeded move'));
  writeFileSync(join(root, 'packages/moves/src/logic/moves/seedBeta.js'), seedDeclaration('seedBeta', 11, false, 'repair the second seeded move'));
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '-m', 'fixture: two independent declarations']);
  const child = `
import { MOVE_OPERATIONS as ENGINE_OPERATIONS } from './packages/moves/index.js';
const { relayMoveActor } = nativeBoardPorts().enginePorts;
import { nextStepWords$NEXT_STEPS as NEXT_STEPS } from './apps/cli/index.js';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import * as store from './packages/store/index.js'; import {openBoard,nativeBoardPorts} from './apps/lib/src/logic/native.js';
import { registryFixtureBoard } from './apps/cli/tests/fixtures/move/registry.js';
import { REGISTRY_AT } from './apps/cli/tests/fixtures/move/registry.js';
const root=process.cwd();
const result={operations:ENGINE_OPERATIONS,alphaActor:relayMoveActor({operation:'seedAlpha',args:[7,{agentId:'seed-agent'}]}),
  alphaStep:NEXT_STEPS.SEEDALPHA,betaStep:NEXT_STEPS.SEEDBETA};
if(ENGINE_OPERATIONS.includes('seedAlpha')&&ENGINE_OPERATIONS.includes('seedBeta')) {
  const {MOVE_REGISTRY,minimumMoveEngine,discoverMoves}=await import('./packages/moves/index.js');
  const {importsIn}=await import('./packages/gate/index.js');
  const snapshot=JSON.parse(readFileSync('./apps/cli/tests/fixtures/move/registry/baseline.json','utf8'));
  const boards=new Map();
  try {
    const forbidden=new Set(['src/board.js','src/engine.js','src/board-engine-ports.js','src/next-step-words.js','src/move-registry.js','src/git.js']);
    const seen=new Set();
    let pending=['packages/moves/src/logic/moves','packages/moves/src/io/moves'].flatMap(folder=>readdirSync('./'+folder).filter(file=>file.endsWith('.js')).map(file=>pathToFileURL(join(root,folder,file)).href));
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
        // A JSON module is data: it must parse and imports nothing, so the walk ends there.
        if(specifier.endsWith('.json')){JSON.parse(readFileSync(fileURLToPath(new URL(specifier,level[index])),'utf8'));continue;}
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
  assert.deepEqual(result.operations.filter(name => SNAPSHOT.operations.includes(name)), SNAPSHOT.operations, 'existing order does not move');
  assert.deepEqual(result.seedFloors, [9, 11]);
  assert.equal(result.pureImportClosure, true, 'routing metadata never imports its consumers, board writers or Git/process launchers');
  assert.equal(result.alphaActor, 'seed-agent');
  assert.equal(result.alphaStep, 'repair the first seeded move');
  assert.equal(result.betaStep, 'repair the second seeded move');
  assert.deepEqual(result.itemIds.filter(name => SNAPSHOT.operations.includes(name)).sort(), [...SNAPSHOT.itemIdFirstArgument].sort(), 'historical true and false slot flags stay exact');
  assert.ok(result.itemIds.includes('rehomeItem'), 're-home retains its item slot');
  assert.ok(result.itemIds.includes('seedAlpha'));
  assert.ok(!result.itemIds.includes('seedBeta'));
  assert.deepEqual(result.floors, SNAPSHOT.floorCases.map(entry => entry.expected), 'all historical first-match floor vectors retain their results');
  assert.deepEqual(result.refusals, [true, true, true], 'bad names, mismatched identities and invalid floors fail closed');
  assert.equal(result.conflictingStepRefused, true, 'two declarations cannot silently disagree about recovery guidance');
  assert.deepEqual(consumerHashes(root), before, 'the three central consumers were never edited to add either move');
});


test('cli.journeys-move-registry.move-import-closure-stays-process-free: move import closure stays process-free on a seeded revision board [C7,V4,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-move-closure-'));
  const board = registryFixtureBoard(directory, 'revision-closure');
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  // Private reader input: floor selection must inspect the recorded revision rather than spawn.
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('row_decisions',
    JSON.stringify([{ event: 7, revision: { source: 'private recorded revision fixture' } }]));
  assert.equal(minimumMoveEngine('applyRowDecisions', [{ events: [7] }], board), SPEC_REVISION_ENGINE);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const forbidden = new Set(['src/board.js', 'src/engine.js', 'src/board-engine-ports.js', 'src/next-step-words.js', 'src/move-registry.js', 'src/git.js']);
  for (const [identity, path] of readPathMap(root)) if (forbidden.has(identity)) forbidden.add(path);
  const seen = new Set();
  let pending = ['packages/moves/src/logic/moves', 'packages/moves/src/io/moves'].flatMap(folder => readdirSync(join(root, folder)).filter(file => file.endsWith('.js'))
    .map(file => pathToFileURL(join(root, folder, file)).href));
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !seen.has(file));
    pending = [];
    for (const file of level) {
      assert.ok(!forbidden.has(fileURLToPath(file).slice(root.length)), 'move declarations load no writer/consumer');
      seen.add(file);
    }
    const inputs = mappedWorkingSources(root, level.map(file => fileURLToPath(file).slice(root.length)));
    const bodies = inputs.flatMap(input => [
      { path: input.implementationPath, body: input.body },
      ...(input.shimBody === null ? [] : [{ path: input.shimPath, body: input.shimBody }]),
    ]);
    for (const input of bodies) assert.ok(!forbidden.has(input.path), 'mapped move declarations load no writer/consumer');
    const edges = importsIn(bodies.map(input => input.body.toString('utf8')));
    for (const [index, imports] of edges.entries()) for (const specifier of imports) {
      assert.notEqual(specifier, 'node:child_process', 'move declarations load no process launcher');
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), 'move imports are native or relative');
      const target = new URL(specifier, pathToFileURL(join(root, bodies[index].path)));
      // A JSON module (packages/items/src/logic/vendors.json) is data: it must parse and imports nothing, so the walk ends there.
      if (specifier.endsWith('.json')) { JSON.parse(mappedWorkingSources(root, [fileURLToPath(target).slice(root.length)])[0].body.toString('utf8')); continue; }
      pending.push(target.href);
    }
  }
});

installStaleStateRegistryCases();

/** Exercise each live invariant without mutating the accepted source or a historical oracle. */
/** Proves the named 145 pair passes while any other duplicate engine number still fails [C7,V4]. */
test('cli.journeys-move-registry.a-new-duplicate-engine-number-outside: clause 1: a new duplicate engine number outside the named historical exception still fails [C7,V4]', () => {
  const base = { registry: {}, sources: [], nextSteps: {} };
  assert.deepEqual(registryProblems({ ...base, leaves: [{ name: 'ITEM_PATCH_AUTO_ENGINE', number: 145 }, { name: 'UNCHANGED_REFREEZE_ENGINE', number: 145 }] }), [], 'the named pair is the one exception');
  assert.match(registryProblems({ ...base, leaves: [{ name: 'ITEM_PATCH_AUTO_ENGINE', number: 145 }, { name: 'UNCHANGED_REFREEZE_ENGINE', number: 145 }, { name: 'THIRD_ENGINE', number: 145 }] }).join(), /duplicate or invalid engine number 145/u);
  assert.match(registryProblems({ ...base, leaves: [{ name: 'NEW_ENGINE', number: 146 }, { name: 'OTHER_NEW_ENGINE', number: 146 }] }).join(), /duplicate or invalid engine number 146/u);
});

test('cli.journeys-move-registry.registry-invariants-reject-missing-recovery-slots: registry invariants reject missing recovery, slots and allocation collisions [C7,V4]', () => {
  const declaration = { operation: 'sample', engine: 1, itemIdFirstArgument: true, nextSteps: { SAMPLE: 'repair the sample' } };
  const input = { registry: { sample: declaration }, leaves: [{ name: 'SAMPLE_ENGINE', number: 1 }],
    sources: ["throw new Refused('SAMPLE', 'repair it');"], nextSteps: declaration.nextSteps };
  assert.deepEqual(registryProblems(input), []);
  assert.deepEqual(registryProblems({ ...input, leaves: [...input.leaves, { name: 'PENDING_ENGINE', number: null }, { name: 'OTHER_PENDING_ENGINE', number: null }] }), [], 'unallocated leaves do not collide');
  assert.match(registryProblems({ ...input, registry: { sample: { ...declaration, itemIdFirstArgument: undefined } } }).join(), /missing item slots/u);
  assert.match(registryProblems({ ...input, registry: { wrong: declaration } }).join(), /mismatched operation/u);
  assert.match(registryProblems({ ...input, leaves: [...input.leaves, { name: 'SAMPLE_ENGINE', number: 2 }] }).join(), /duplicate engine name/u);
  assert.match(registryProblems({ ...input, leaves: [...input.leaves, { name: 'OTHER_ENGINE', number: 1 }] }).join(), /duplicate or invalid engine number/u);
  assert.match(registryProblems({ ...input, nextSteps: {} }).join(), /missing recovery entry SAMPLE/u);
  assert.match(registryProblems({ ...input, sources: ["throw new Refused('UNDECLARED', 'repair it');"] }).join(), /missing recovery entry UNDECLARED/u);
});


test('cli.journeys-move-registry.shipped-engine-records-and-the-legacy: shipped engine records and the legacy replay retain their first committed bytes [C7,V4]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const git = (...args) => run(root, 'git', args);
  assert.deepEqual(historyProblems(root, readEngineLeaves(join(root, ENGINE_FOLDER)), git), []);
});

installRegistryMergeCase();

/** Proves every refusal code a registered move declares carries a non-empty recovery step, with no fixed count [C7]. */
test('cli.journeys-move-registry.every-refusal-a-registered-move-raises: clause 1: every refusal a registered move raises has a recovery next step [C7]', () => {
  const codes = new Set(Object.values(MOVE_REGISTRY).flatMap(declaration => Object.keys(declaration.nextSteps ?? {})));
  assert.ok(codes.size > 0, 'the registry declares refusal codes to check');
  for (const code of codes) {
    assert.equal(typeof NEXT_STEPS[code], 'string', code);
    assert.notEqual(NEXT_STEPS[code].trim(), '', code);
  }
});
