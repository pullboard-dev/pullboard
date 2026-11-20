/** @pullboard-test-input packages/state/data/history/legacy.json */
/** @pullboard-test-input packages/state/data/history/*.json */
/** Engine history and the move closure read the moves cell, so deleting src/moves changes neither [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../index.js';
import { packageFiles } from '../../../index.js';
import { assignEngineNumbers } from '../../../../state/index.js';
import { importsIn } from '../../../../gate/heavy.js';
import { commonJsIn } from '../../../../gate/heavy.js';
import { moveDeclarationFiles } from '../../../../codemap/index.js';

/** Build a tree whose move bodies live in the moves cell, with or without the src/moves shims. */
function engineTree(t, shims) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-moves-cell-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write one synthetic source file. */
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  put('packages/state/data/history/legacy.json', '{}');
  put('packages/state/src/logic/engines/base-engine.js', 'export const BASE_ENGINE = 40;\n');
  put('packages/state/src/logic/engines/alpha-engine.js', "import { unassignedEngine } from './engine-next.js';\nexport const ALPHA_ENGINE = unassignedEngine();\n");
  put('packages/moves/src/logic/moves/addThing.js', 'export default { operation: "addThing", engine: 40 };\n');
  put('packages/moves/src/io/moves/recordThing.js', 'export default { operation: "recordThing", engine: 40 };\n');
  if (shims) {
    put('src/moves/addThing.js', 'export { default } from "../../packages/moves/src/logic/moves/addThing.js";\n');
    put('src/moves/recordThing.js', 'export { default } from "../../packages/moves/src/io/moves/recordThing.js";\n');
  }
  return root;
}

test('runners.moves.engine-numbers-and-their-frozen-history: engine numbers and their frozen history are the same with or without the src/moves shims [C7,H16]', t => {
  const results = [true, false].map(shims => {
    const root = engineTree(t, shims);
    const { assigned } = assignEngineNumbers(root);
    return { assigned, history: readFileSync(join(root, 'packages/state/data/history/41.json'), 'utf8') };
  });
  assert.deepEqual(results[0].assigned, [{ name: 'ALPHA_ENGINE', number: 41 }]);
  assert.deepEqual(results[1], results[0], 'a tree without src/moves numbers and records exactly like one with the shims');
  assert.deepEqual(Object.keys(JSON.parse(results[1].history).declarations), ['addThing.js', 'recordThing.js'],
    'the record freezes the packaged bodies, never the shims');
});

test('runners.moves.the-real-move-closure-without-src: the real move closure without src/moves is the shimmed closure minus its shims [C7,H16]', t => {
  const root = join(import.meta.dirname, '../../../../..');
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-moves-cell-closure-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const files = packageFiles(root);
  copyPackageFiles(root, fixture, { files });
  /** The bounded declaration closure of the fixture tree as a sorted list. */
  const closure = () => [...moveDeclarationFiles(fixture, { files, importsIn, commonJsIn })].sort();
  const withShims = closure();
  assert.ok(withShims.some(file => file.startsWith('packages/moves/src/logic/moves/')), 'the packaged bodies are reached');
  rmSync(join(fixture, 'src/moves'), { recursive: true, force: true });
  const withoutShims = closure();
  assert.deepEqual(withoutShims, withShims.filter(file => !file.startsWith('src/moves/')),
    'deleting src/moves removes only the shims from the closure');
});
