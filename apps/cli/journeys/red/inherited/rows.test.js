/** Two approved rows gating one red file name no row and no owning item, and leave next as it was [V1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItems } from '../../../tests/fixtures/red/main-red.js';
import { builder } from '../../../tests/fixtures/red/main-red.js';
import { cli } from '../../../tests/fixtures/red/main-red.js';
import { commit } from '../../../tests/fixtures/red/main-red.js';
import { fixture } from '../../../tests/fixtures/red/main-red.js';
import { gateFacts } from '../../../tests/fixtures/red/main-red.js';
import { put } from '../../../tests/fixtures/red/main-red.js';
import { settledRed } from '../../../tests/fixtures/red/main-red.js';
import { FAILING_TEST } from '../../../tests/fixtures/red/main-red.js';

test('multiple approved rows never produce a guessed row or item [V1,C7]', async t => {
  const spec = [
    '# Ambiguous gate fixture\n\n## G · Goals',
    '- G1 [approved, must] First gate row. | gate: test/inherited.test.js',
    '- G2 [approved, must] Second gate row. | gate: test/inherited.test.js',
    '- G3 [approved, must] Submit row. | gate: test/unrelated.test.js',
    '- G4 [approved, must] Earlier work row. | gate: test/earlier.test.js',
  ].join('\n') + '\n';
  const box = fixture(t, { spec, source: FAILING_TEST });
  const [first, second, earlier, submitItem] = addItems(box, [
    { title: 'First possible repair', specId: 'G1' },
    { title: 'Alternate owner mending a shared gate', specId: 'G2' },
    { title: 'Earlier milestone work', specId: 'G4' },
    { title: 'Unrelated submit', specId: 'G3' },
  ]);
  assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--reason', 'Arrange fixture release', '--items', String(earlier)).code, 0);
  assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--reason', 'Arrange fixture release', '--items', `${first},${second}`).code, 0);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): select ambiguous inherited red [G2]');
  const { shown, job } = await settledRed(t, box, submitter, submitItem, { args: ['--infra', 'append a candidate-only test marker to exercise inherited red ownership'], until: doc => doc?.item_status === 'submitted' });
  const accepted = gateFacts(shown, job.id).find(text => text.includes("(not this item's; accepted)"));
  assert.ok(accepted, gateFacts(shown, job.id).join('\n---\n'));
  assert.match(accepted, /^also fails on main: proof test\/inherited\.test\.js /mu);
  assert.doesNotMatch(accepted, /inherited main red|approved row|open rework #/u, 'no row or owner is guessed');
  assert.doesNotMatch(accepted, new RegExp(`#${first}\\b|#${second}\\b`, 'u'));
  const next = builder(box).run('next', '--json');
  assert.equal(next.code, 0, next.err);
  assert.equal(JSON.parse(next.out).item.item_id, earlier, 'ambiguous owners leave next in its original milestone order');
});
