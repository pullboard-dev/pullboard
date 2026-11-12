/** @pullboard-test-input source-tree */
/** A submit refused with NO_GATE ends within seconds and starts no runner work [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builderRepo,
  commitAll,
  privateRepo,
  put,
} from '../../tests/fixtures/submit/gate.js';
import {
  coordinatorLocal,
  runLocal,
} from './gate/local.js';

test('a submit refused with NO_GATE exits within seconds and starts no runner work [C7,#4995]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: '', shared: ['pullboard.json'] }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  box = builderRepo(box);
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'No gate yet', '--specs', 'G1')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): build the claimed item [G1]');
  const refused = await runLocal(box, 'submit', '1', '--json');
  assert.equal(refused.code, 1, refused.err || refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_GATE');
  assert.doesNotMatch(`${refused.out}\n${refused.err}`, /baseline|runner/iu, 'a refused submit starts no runner work');
});
