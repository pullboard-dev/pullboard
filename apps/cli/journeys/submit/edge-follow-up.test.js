/** With submit.edgeFollowUps on, a settled submit whose diff adds an import edge files one linked follow-up; off, it files nothing (#8874) [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { inProcess } from '../../tests/fixtures/submit/fail.js';
import { project } from '../../tests/fixtures/submit/fail.js';
import { submitAndSettle } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

/** A project whose item adds an import edge between two modules, submitted and settled with the setting on or off; returns the box and the item's children. */
async function settledBox(t, edgeFollowUps) {
  const { box } = await project(t, { extra: { submit: { requireInfraNote: false, autoFileMainReds: false, edgeFollowUps } } });
  put(box.root, 'src/b.js', 'export const b = 1;\n');
  put(box.root, 'src/a.js', "import './b.js';\nexport const value = 1;\n");
  commitAll(box, 'feat(core): a imports b [G1]');
  const done = await submitAndSettle(t, box);
  assert.equal(done.gate?.green, true, JSON.stringify(done.gate));
  return box;
}

/** The item's children after a settled submit, read from the board export. */
async function childrenOf(box, edgeFollowUps) {
  const exported = await inProcess(box, box.root, 'export', '--json');
  assert.equal(exported.code, 0, exported.err);
  const children = JSON.parse(exported.out).tables.item.filter(row => row.item_parent_id === 1);
  if (!children.length && edgeFollowUps) assert.fail(`no follow-up filed; the item's thread: ${(await inProcess(box, box.root, 'show', '1')).out.slice(-1500)}`);
  return children;
}

async function settled(t, edgeFollowUps) { return childrenOf(await settledBox(t, edgeFollowUps), edgeFollowUps); }

test('cli.journeys-submit-edge-follow-up.with-submit-edgefollowups-on-a-submit: clause 1: with submit.edgeFollowUps on, a submit whose diff adds an import edge files exactly one linked follow-up [C7]', async t => {
  const children = await settled(t, true);
  assert.equal(children.length, 1, JSON.stringify(children));
  assert.match(children[0].item_brief, /src\/a\.js -> src\/b\.js/u, 'the follow-up lists the new edge');
});

test('cli.journeys-submit-edge-follow-up.with-submit-edgefollowups-at-its-default: clause 2: with submit.edgeFollowUps at its default (off), the same submit files nothing [C7]', async t => {
  assert.deepEqual(await settled(t, false), []);
});

test('cli.journeys-submit-edge-follow-up.a-second-submit-of-the-same-edge: clause 1: with submit.edgeFollowUps on, a second submit of the same added import edge files no second follow-up and links the follow-up already filed [C7]', async t => {
  const box = await settledBox(t, true);
  const first = await childrenOf(box, true);
  assert.equal(first.length, 1, JSON.stringify(first));
  const reviewer = join(box.dir, 'repo');
  runFixtureGit(['fetch', '--quiet', box.root, 'HEAD'], { cwd: reviewer, env: box.env });
  runFixtureGit(['switch', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: reviewer, env: box.env });
  const rejected = await inProcess(box, reviewer, 'verify', '1', 'reject', '--as', 'coordinator', '--reason', 'TEST_FAILURE', '--clause', 'the fixture change is submitted or refused', '--note', 'send it back so the same edge is submitted again');
  assert.equal(rejected.code, 0, JSON.stringify(rejected));
  runFixtureGit(['switch', '--quiet', 'main'], { cwd: reviewer, env: box.env });
  put(box.root, 'src/a.js', "import './b.js';\nexport const value = 2;\n");
  commitAll(box, 'feat(core): a imports b, value 2 [G1]');
  const dropped = await inProcess(box, reviewer, 'withdraw', String(first[0].item_id), 'the follow-up is closed so the item can be submitted again');
  assert.equal(dropped.code, 0, JSON.stringify(dropped));
  const claimed = await inProcess(box, box.root, 'claim', '1');
  assert.equal(claimed.code, 0, JSON.stringify(claimed));
  const again = await submitAndSettle(t, box);
  assert.equal(again.gate?.green, true, JSON.stringify(again.gate));
  const second = await childrenOf(box, true);
  assert.equal(second.length, 1, `no second follow-up: ${JSON.stringify(second)}`);
  const thread = (await inProcess(box, box.root, 'show', '1')).out;
  const links = thread.match(/Edge follow-up filed as #\d+/gu) ?? [];
  assert.deepEqual(links, [`Edge follow-up filed as #${first[0].item_id}`], 'the thread links the one follow-up already filed, once');
});
