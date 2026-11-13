/** A train merge body is only the item trailer, apart from push.test.js so each fits its file limit under pull [B3,R3]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a train merge body is only the item trailer even when the local Git config logs merges [B3,R3]', async () => {
  const box = landProject();
  verifiedFour(box, { order: [0, 1, 2, 3] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'config', 'merge.log', 'true');
  const result = await settleLand(box, json(box, box.repo, 'land'));
  assert.equal(result.landed.length, 4);
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of result.landed.entries()) {
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'merge.log=true appends no shortlog to the body');
  }
});
