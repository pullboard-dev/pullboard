/** With submit.edgeFollowUps on, a settled submit whose diff adds an import edge files one linked follow-up; off, it files nothing (#8874) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inProcess } from '../../tests/fixtures/submit/fail.js';
import { project } from '../../tests/fixtures/submit/fail.js';
import { submitAndSettle } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

/** A project whose item adds an import edge between two modules, submitted and settled with the setting on or off; returns the box and the item's children. */
async function settled(t, edgeFollowUps) {
  const { box } = await project(t, { extra: { submit: { requireInfraNote: false, autoFileMainReds: false, edgeFollowUps } } });
  put(box.root, 'src/b.js', 'export const b = 1;\n');
  put(box.root, 'src/a.js', "import './b.js';\nexport const value = 1;\n");
  commitAll(box, 'feat(core): a imports b [G1]');
  const done = await submitAndSettle(t, box);
  assert.equal(done.gate?.green, true, JSON.stringify(done.gate));
  const exported = await inProcess(box, box.root, 'export', '--json');
  assert.equal(exported.code, 0, exported.err);
  const children = JSON.parse(exported.out).tables.item.filter(row => row.item_parent_id === 1);
  if (!children.length && edgeFollowUps) assert.fail(`no follow-up filed; the item's thread: ${(await inProcess(box, box.root, 'show', '1')).out.slice(-1500)}`);
  return children;
}

test('clause 1: with submit.edgeFollowUps on, a submit whose diff adds an import edge files exactly one linked follow-up [C7]', async t => {
  const children = await settled(t, true);
  assert.equal(children.length, 1, JSON.stringify(children));
  assert.match(children[0].item_brief, /src\/a\.js -> src\/b\.js/u, 'the follow-up lists the new edge');
});

test('clause 2: with submit.edgeFollowUps at its default (off), the same submit files nothing [C7]', async t => {
  assert.deepEqual(await settled(t, false), []);
});
