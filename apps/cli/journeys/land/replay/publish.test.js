/** Publish pushes only a head the whole suite passed, apart from replay.test.js so each fits its file limit under pull [B3,R3]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { calls } from '../../../tests/fixtures/land/board.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { settleRecordedSourceWake } from '../../../tests/fixtures/land/board.js';
import { recordManualMergedItems } from '../../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, waitFor } = e2e;
const { FILES, landProject, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('publish pushes only a head the whole suite passed and names every red [B3,R3]', async () => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 1 });
  const before = box.git(box.remote, 'rev-parse', 'main');
  // Tier 1 by hand: each verified item lands on the local trunk only, as pullboard merged records it.
  recordManualMergedItems(box, entries);
  // Manual merged calls start native source advances; close their exact recorded wake before measuring publish.
  await settleRecordedSourceWake(box, { waitFor });
  const head = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, 'a red head fails publish');
  const report = JSON.parse(red.out);
  assert.equal(report.published, false);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before, 'a red head is never pushed');
  assert.deepEqual(report.red.map((entry) => entry.file), [FILES[1]], 'every failing test is named from the one run');
  assert.deepEqual(report.red[0].items, [entries[1].item], 'the failing file names the landed item whose merge touched it');
  assert.equal(calls(box).length - start, 1, 'one whole-suite run');
  const again = box.run(box.repo, 'publish', '--json');
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).waiting, true, 'the same red head waits for a new head');
  assert.equal(calls(box).length - start, 1, 'waiting runs no tests');
  // A fix lands on the trunk; the new head passes the whole suite and is pushed exactly.
  assert.equal(commitFile(box, box.repo, FILES[1], 'PASS\n', 'fix(web): land fixture 2 passes again [G1]').status, 0);
  const fixed = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(fixed, head);
  const green = json(box, box.repo, 'publish');
  assert.equal(green.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), fixed, 'only the head the whole suite passed reaches the remote');
});
