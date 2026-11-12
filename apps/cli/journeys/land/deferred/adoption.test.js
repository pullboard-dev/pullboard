/** An uncertain affected batch passes its full gate before local adoption, apart from deferred.test.js so each fits its file limit under pull [B3,R3,C7,V4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { calls } from '../../../tests/fixtures/land/board.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('an uncertain affected batch passes its full gate before local adoption [B3,R3,C7,V4]', () => {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land on the local trunk first');
  const entries = verifiedFour(box);
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed.sort((a, b) => a - b), entries.map((entry) => entry.item).sort((a, b) => a - b));
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip, 'the local trunk holds the landed batch');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'tier 1 pushes nothing');
  assert.equal(calls(box).length - start, 1, 'an unsupported fixture graph requires one full gate before adoption');
  const merges = box.git(box.repo, 'rev-list', '--first-parent', `${result.batch.base}..${result.batch.tip}`).split('\n');
  for (const entry of entries) assert.ok(merges.includes(json(box, box.repo, 'show', String(entry.item)).item_merged_commit), `#${entry.item} has its merged receipt on the local trunk`);
  // Tier 2 then runs the whole suite once on that exact head and pushes it.
  const published = json(box, box.repo, 'publish');
  assert.equal(published.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(calls(box).length - start, 2, 'publish also proves its exact trunk head before pushing');
});
