/** The board composition root lives in a package: it opens a real board with every port composed and imports no app [C7]. */
/** @pullboard-world-pin: the last clause-1 test reads the cell's own three source files to prove none reaches an app. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindBoardView } from '../index.js';
import { nativeBoardPorts } from '../index.js';
import { openBoard } from '../index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Every source file of the cell: the front door that is the root, its lazily loaded providers and the owner-wait seal. */
const SOURCES = ['packages/board/index.js', 'packages/board/src/logic/ports.js', 'packages/board/src/io/seal.js'];
/** The bags a composed board carries, the same set the library has always handed out. */
const PORT_BAGS = ['auth', 'enginePorts', 'guards', 'lifecycle', 'logEvent', 'nativePorts', 'operations', 'presentation', 'query', 'sourceAdvanceReceipts', 'verification'];

test('clause 1: packages/board composes the full board port bag, and its openBoard is the one the bag hands out [C7]', () => {
  const ports = nativeBoardPorts();
  assert.deepEqual(Object.keys(ports).sort(), PORT_BAGS);
  assert.equal(typeof ports.nativePorts.atomic, 'function', 'the native ports carry the store transaction');
  assert.equal(Object.isFrozen(ports.nativePorts), true);
  assert.equal(typeof ports.enginePorts.operations, 'object', 'the engine ports carry the operation table');
  assert.equal(ports.presentation.openBoard, openBoard, 'the composition hands out the package openBoard itself');
});

test('clause 1: a view projection refuses until the app binds the view, and the bound loader runs only at the first projection [C7]', () => {
  const presentation = nativeBoardPorts().presentation;
  assert.throws(() => presentation.projectState(), error => error.code === 'BOARD_VIEW_UNBOUND');
  let loads = 0;
  bindBoardView(() => { loads += 1; return { projectState: () => 'projected', activeViewAgents: () => [], viewProofSummary: () => null }; });
  assert.equal(loads, 0, 'binding loads nothing');
  assert.equal(presentation.projectState(), 'projected');
  assert.equal(presentation.projectState(), 'projected');
  assert.equal(loads, 1, 'the view loads once, at the first projection');
});

test('clause 1: no packages/board source imports, requires or names an apps/ path [C7]', () => {
  for (const file of SOURCES) {
    const source = readFileSync(`${ROOT}${file}`, 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s*|import\(\s*|requireModule\(\s*|require\(\s*)['"]([^'"]+)['"]/gu)].map(match => match[1]);
    assert.ok(specifiers.length > 0, `${file} has imports to check`);
    for (const specifier of specifiers.filter(name => name.startsWith('.'))) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      assert.ok(!target.startsWith('apps/'), `${file} reaches ${target}`);
    }
    assert.doesNotMatch(source, /['"`][./]*apps\//u, `${file} names an apps/ path`);
  }
});
