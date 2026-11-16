/** With submit.edgeFollowUps on, a submit whose diff adds an import edge files one linked follow-up; off, it files nothing (#8874) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { commit } from '../../tests/fixtures/guards.js';
import { e2e } from '../../tests/fixtures/guards.js';
import { put } from '../../tests/fixtures/guards.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

after(e2e.cleanup);

/** A project whose item adds an import edge between two modules, submitted with the setting on or off; returns the box and the item id. */
async function submitted(edgeFollowUps) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('src/');
  config.submit = { ...(config.submit ?? {}), edgeFollowUps };
  put(box.repo, 'pullboard.json', JSON.stringify(config));
  put(box.repo, 'package.json', '{"type":"module"}\n');
  put(box.repo, 'src/a.js', 'export const a = 1;\n');
  put(box.repo, 'src/b.js', 'export const b = 1;\n');
  put(box.repo, 'web/item.test.js', "import { test } from 'node:test';\ntest('item works [G1]', () => {});\n");
  commit(box, box.repo, 'test: accepted edge policy');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = await fixtureAdd(box.runLocal, box.repo, 'web', 'edge fixture', '--specs', 'G1',
    '--criterion', 'The item passes.', '--check', 'node --test web/item.test.js', '--json');
  assert.equal(made.code, 0, made.err + made.out);
  const id = JSON.parse(made.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  put(box.web, 'src/a.js', "import './b.js';\nexport const a = 1;\n");
  commit(box, box.web, 'feat(core): a imports b [G1]');
  const sent = await box.runLocal(box.web, 'submit', String(id));
  assert.equal(sent.code, 0, sent.err + sent.out);
  return { box, id };
}

/** The items the board lists under a parent, by the export every journey reads. */
async function childrenOf(box, id) {
  const exported = await box.runLocal(box.web, 'export', '--json');
  assert.equal(exported.code, 0, exported.err);
  return JSON.parse(exported.out).tables.item.filter(row => row.item_parent_id === id);
}

test('clause 1: with submit.edgeFollowUps on, a submit whose diff adds an import edge files exactly one linked follow-up [C7]', async () => {
  const { box, id } = await submitted(true);
  const children = await childrenOf(box, id);
  assert.equal(children.length, 1, JSON.stringify(children));
  assert.match(children[0].item_brief, /src\/a\.js -> src\/b\.js/u, 'the follow-up lists the new edge');
  const resent = await box.runLocal(box.web, 'submit', String(id));
  assert.equal((await childrenOf(box, id)).length, 1, `a second submit files no second follow-up: ${resent.err}`);
});

test('clause 2: with submit.edgeFollowUps at its default (off), the same submit files nothing [C7]', async () => {
  const { box, id } = await submitted(false);
  assert.deepEqual(await childrenOf(box, id), []);
});
