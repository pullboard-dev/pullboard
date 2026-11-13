/** A project with the deprecated submit.handoff on still submits through the pull gate: one gate job row, no hand-off worker [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

test('clause 2: submit.handoff true settles through the pull gate [P7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: deprecated submit.handoff on [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const { document, commit } = submitOne(box, id);
  assert.equal(document.queued, true);
  const { board } = await pullQueue(t, box);
  const rows = jobsOf(board.db, { kind: 'gate' });
  assert.deepEqual(rows.map(row => [row.item, row.step, row.candidate]), [[id, 'offered', commit]], 'one offered gate job row');
  assert.equal(submitHandoff(board, id), null, 'no queued hand-off worker');
});
