/** @pullboard-test-input source-cell apps/cli */
/** The golden release journey: a version cut walks the real CLI from a clean board to a recorded release [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 1: a version cut walks the CLI from a clean board to a recorded release at main [C7]', async () => {
  const box = e2e.project();
  const run = (...args) => box.runIn(box.repo, ...args);
  const json = async (...args) => {
    const result = await run(...args, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    return JSON.parse(result.out);
  };

  assert.match((await run('roadmap')).out, /no milestones|^$/iu, 'a clean board has no release yet');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Ship the page', '--specs', 'G1');
  assert.equal(added.code, 0, added.err);
  assert.equal((await run('milestone', 'add', '1.0', '--note', 'first cut')).code, 0);
  const id = Number(/#(\d+)/u.exec(added.out)?.[1]);
  assert.equal((await run('milestone', 'items', '1.0', '--add', String(id), '--reason', 'the cut scope')).code, 0);

  assert.equal((await run('milestone', 'add', '1.1')).code, 0);
  const main = box.git(box.repo, 'rev-parse', 'main');
  const shipped = await json('milestone', 'ship', '1.0');
  assert.equal(shipped.milestone.shipped.commit, main, "the release is recorded at main's commit");
  assert.deepEqual([shipped.into, shipped.moved], ['1.1', [id]], 'the unlanded item carries into the next release');
  const roadmap = await json('roadmap');
  const text = JSON.stringify(roadmap);
  assert.ok(text.includes(main), 'the roadmap shows the recorded release commit');
  const again = await run('milestone', 'ship', '1.0');
  assert.notEqual(again.code, 0, 'a recorded release cannot be cut twice');
});
