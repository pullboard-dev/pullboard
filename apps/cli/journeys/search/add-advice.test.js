/** pullboard add prints the nearest open items as advice after filing, and never refuses or fails because of them [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** File one item through the fixture helper, keeping the advice lines the add printed beside the filed item. */
async function file(box, title, criterion) {
  let last;
  const run = async (root, ...args) => (last = await box.runLocal(root, ...args));
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title, criterion, check: 'true', diagnose: false, args: ['--specs', 'G1'], run });
  const advice = JSON.parse(last.out).diagnostics ?? [];
  return { id: item.item_id, advice };
}

const LANDING = ['Landing queue stalls when the runner quarantine fills', '1. The landing queue drains after a runner quarantine [test].'];
const REWORDED = ['Runner quarantine fills and the landing queue stalls', '1. A quarantined runner never stalls the landing queue [test].'];

/** The id and score of each related item an add printed. */
function related(advice) {
  return advice.filter(line => /^ {2}\d\.\d{3} {2}#\d+ {2}/u.test(line))
    .map(line => ({ score: Number(line.trim().split(' ')[0]), id: Number(line.match(/#(\d+)/u)[1]) }));
}

test('clause 1: add prints the nearest open items with scores after filing, the earlier duplicate first [C7]', async () => {
  const box = e2e.project();
  const first = await file(box, ...LANDING);
  await file(box, 'Tidy the cockpit header gradient', '1. The header shows the lane name in plain type [test].');
  await file(box, 'Relay reconnects after a laptop sleeps', '1. The relay link survives sleep [test].');
  const second = await file(box, ...REWORDED);
  const listed = related(second.advice);
  assert.equal(listed[0].id, first.id, second.advice);
  assert.ok(listed[0].score > 0 && listed.length <= 3, second.advice);
  assert.ok(listed.every(row => row.id !== second.id), 'the new item is not its own match');
});

test('clause 2: add files the item and exits 0 when the index is missing or broken [C7]', async () => {
  const box = e2e.project();
  await file(box, ...LANDING);
  const sidecars = join(box.repo, '.git', 'pullboard', 'search');
  rmSync(sidecars, { recursive: true, force: true });
  assert.ok((await file(box, ...REWORDED)).id > 0, 'filed with no index');
  mkdirSync(sidecars, { recursive: true });
  for (const name of ['tfidf.index']) writeFileSync(join(sidecars, name), '{ not json');
  const again = await file(box, 'Landing queue drains slowly', '1. The landing queue drains in a minute [test].');
  assert.ok(again.id > 0, 'filed with a broken index');
});

test('clause 3: closed items are not listed [C7]', async () => {
  const box = e2e.project();
  const closed = await file(box, ...LANDING);
  const withdrawn = await box.runLocal(box.repo, 'withdraw', String(closed.id), 'duplicate of another item');
  assert.equal(withdrawn.code, 0, `${withdrawn.out}\n${withdrawn.err}`);
  const open = await file(box, 'Landing queue stalls when runners are quarantined', '1. The landing queue is never stalled by quarantined runners [test].');
  const next = await file(box, ...REWORDED);
  const listed = related(next.advice).map(row => row.id);
  assert.ok(listed.includes(open.id), next.advice);
  assert.ok(!listed.includes(closed.id), next.advice);
});
