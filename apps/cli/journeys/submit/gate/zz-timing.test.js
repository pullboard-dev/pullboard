import { test } from 'node:test';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../../tests/fixtures/submit/gate.js';
import { coordinatorLocal } from './local.js';
import { runLocal } from './local.js';
import { submitSettled } from './local.js';
/** @pullboard-test-input source-tree */
/** timing probe, temporary. */
test('phases [C7]', async (t) => {
  const T = (l, s) => console.log(l, Date.now() - s);
  let s = Date.now(); const pre = privateRepo(t); T('privateRepo-extra', s);
  s = Date.now(); put(pre.root,'a.js','1'); commitAll(pre); T('plain-commit-hooks', s);
  s = Date.now(); let box = privateRepo(t); T('privateRepo', s);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box); s = Date.now(); commitAll(box); T('commit', s);
  s = Date.now(); box = builderRepo(box); T('builderRepo', s);
  s = Date.now(); await coordinatorLocal(box, 'add', 'build', 'X', '--check', 'true'); T('add', s);
  s = Date.now(); await runLocal(box, 'claim', '1'); T('claim', s);
  put(box.root, 'src/a.js', 'export const value = 2;\n'); s = Date.now(); commitAll(box, 'feat(core): x [G1]'); T('commit2', s);
  s = Date.now(); const r = await submitSettled(t, box, (...a) => runLocal(box, ...a)); T('submitSettled ' + r.code, s);
});
