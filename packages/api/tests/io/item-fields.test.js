/** @pullboard-test-input source-cell packages/api packages/store packages/config */
/** The item API sends an item's typed fields and related links when items.typedFields is on, and leaves both out when it is off (#9835, #1321) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { boardId } from '../../../store/index.js';
import { declareItemField } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { relateItems } from '../../../store/index.js';
import { setItemField } from '../../../store/index.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { serveApi } from '../../index.js';

const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`an item call does not project ${name}`); }])));

/** A served board with two items, a number field set on the first, and the two items related, all written through the store in this process. */
async function fixture(t) {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  const setting = on => fixtureMachineSettings(home, { items: { typedFields: on } });
  setting(true);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  mkdirSync(dirname(project.boardFile), { recursive: true });
  const board = openCellBoard(project.boardFile);
  let id, ids;
  try {
    id = boardId(board);
    ids = ['Alpha item', 'Beta item'].map(title => cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: 'It holds a field.' }).item_id);
    declareItemField(board, { by: 'coordinator', name: 'points', type: 'number', enabled: true });
    setItemField(board, { by: 'coordinator', id: ids[0], name: 'points', value: 5, enabled: true });
    relateItems(board, { by: 'coordinator', a: ids[0], b: ids[1], enabled: true });
  } finally { closeCellBoard(board); }
  const secret = 'fixture-secret';
  const api = await serveApi({ projects: () => [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-14' }], secret, runCommand: async () => 0, isMain: false,
    refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }), boardOpeners: OPENERS, viewPorts: VIEW_PORTS });
  t.after(() => api.close());
  const item = async number => {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/items/${number}`, { headers: { 'x-pullboard-key': secret }, signal: AbortSignal.timeout(10_000) });
    return await response.json();
  };
  return { ids, item, setting };
}

test('clause 1: with items.typedFields on the item API sends fields and links, and with it off omits both [C7,#9835]', async t => {
  const { ids: [a, b], item, setting } = await fixture(t);
  const on = (await item(a)).item;
  assert.deepEqual(on.fields, [{ name: 'points', type: 'number', value: 5 }]);
  assert.deepEqual(on.links, [{ id: b, title: 'Beta item' }]);
  setting(false);
  const off = (await item(a)).item;
  assert.equal(Object.hasOwn(off, 'fields'), false);
  assert.equal(Object.hasOwn(off, 'links'), false);
  setting(true);
  assert.deepEqual((await item(a)).item.fields, [{ name: 'points', type: 'number', value: 5 }], 'turning it back on sends them again');
});
