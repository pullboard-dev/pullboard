import { localDependencyIds } from '../../../../packages/items/index.js';
import { dependencyLabel } from '../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../packages/items/index.js';
import { withLocalSeatPresence } from '../../../../packages/store/index.js';
/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Native query capabilities preserve actual cell boundaries and fail closed before storage [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cellInventory,
  mappedPath,
  readPathMap,
} from '../../../../packages/codemap/index.js';
import {
  commonJsIn,
  importsIn,
} from '../../../../packages/gate/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import {
  nativeBoardPorts,
  openBoard,
} from '../../../lib/src/logic/native.js';
import * as queries from '../../../../packages/store/index.js';
import * as store from '../../../../packages/store/index.js';
import {
  readyItems,
  routingCapacity,
} from '../../../../packages/queue/index.js';
import { workQueue } from '../../../../packages/items/index.js';
import { roadmap } from '../../../../packages/store/index.js';
import { eligibilityProblem } from '../../../../packages/verify/index.js';
import { lineSettings } from '../../../../packages/state/index.js';
import { observeWorkers } from '../../src/io/scale.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('the actual stats seats verify items and queue graphs have no board-query imports [C7,CD64]', () => {
  const plan = readPlan(ROOT), map = readPathMap(ROOT);
  const provider = plan.cells.flatMap(cell => cell.paths).find(([, to]) => to === 'packages/store/src/io/board/query.js');
  assert.ok(provider, 'the real committed plan retains the native query provider');
  const targets = new Set([...provider.slice(0, 2), mappedPath(map, provider[0])]);
  const { files, edges } = cellInventory(ROOT, { importsIn, commonJsIn });
  assert.ok([...targets].some(path => files.has(path)), 'the actual provider still exists');
  for (const name of ['stats', 'seats', 'verify', 'items', 'queue']) {
    const cell = plan.cells.find(row => row.name === name);
    assert.ok(cell, `the committed plan identifies ${name}`);
    const sources = new Set([cell.frontDoor, ...cell.paths.flatMap(([from, to]) => [from, to, mappedPath(map, from)])]);
    const actual = [...edges].filter(([file]) => sources.has(file) || file.startsWith(`${cell.root}/`));
    assert.ok(actual.length > 0, `inspect real ${name} sources, including the already-landed seats cut`);
    const crossings = actual.flatMap(([from, rows]) => rows.filter(({ target }) => targets.has(target))
      .map(({ target }) => `${from} -> ${target}`));
    assert.deepEqual(crossings, [], `${name} receives actual query readers from its connection's higher composition root`);
  }
});

test('missing connection query readers refuse before SQLite or its directory exists [C7,B1,B2]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-query-ports-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parent = join(directory, 'never-created'), file = join(parent, 'board.sqlite');
  for (const key of ['agentModel', 'proofReceipts', 'itemById', 'laneHold', 'laneHolds', 'getItem', 'listAgents', 'reviewHolder', 'listItems']) {
    const original = nativeBoardPorts();
    const ports = { ...original, nativePorts: { ...original.nativePorts, [key]: null } };
    assert.throws(() => {
      // @pullboard-board-file persistence: absent reader authority must refuse before creating storage.
      openBoard(file, undefined, { ports });
    }, error => error.code === 'NO_POLICY' && error.message.includes(`nativePorts.${key}`));
    assert.equal(existsSync(parent), false, `${key} is checked before directory creation`);
  }
});

test('real read-only status scale and roadmap readers preserve ready order without native write ports [C7,N2]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-read-query-ports-'));
  let writer, reader;
  t.after(() => {
    try { if (reader) queries.closeBoard(reader); }
    finally {
      try { if (writer) store.closeBoard(writer); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
  const file = join(directory, 'board.sqlite');
  // @pullboard-board-file persistence: prove the actual read-only opener has no native write capabilities.
  writer = openBoard(file);
  store.register(writer, { lane: 'coordinator', path: directory, family: 'Fixture Owner' });
  const first = store.addItem(writer, { by: 'coordinator', lane: 'core', title: 'Ready first' });
  const blocked = store.addItem(writer, { by: 'coordinator', lane: 'core', title: 'Wait for first', after: [first] });
  reader = queries.openBoardForRead(file, writer.clock);
  assert.equal(reader.readOnly, true);
  assert.equal(reader.nativePorts, undefined);
  assert.deepEqual(readyItems(reader, store.foreignBlockers, { ...queries, localDependencyIds, dependencyLabel, itemFileCollisions }).map(item => item.item_id), [first]);
  const ports = { ...store, roadmap, eligibilityProblem, localDependencyIds, dependencyLabel, itemFileCollisions };
  const queue = workQueue(reader, ports);
  assert.deepEqual(queue, workQueue(writer, ports), 'the same persisted snapshot retains all queue ordering and blockers');
  assert.ok(queue.unreleased.find(item => item.id === blocked).waits.some(reason => reason.includes(`#${first}`)));
  assert.equal(routingCapacity(reader, queries.listAgents(reader), store.foreignBlockers, { ...queries, localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence, lineSettings }).readyItems, 1);
  assert.equal(observeWorkers(reader, { lane: 'core', managed: [] }).builds, 1);
});
