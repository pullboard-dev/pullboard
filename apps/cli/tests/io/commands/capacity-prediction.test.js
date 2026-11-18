/** pullboard capacity prints how well predicted files matched the files submits changed [C7,#8523,#1413]. */
// fixture-subject: addItem (the board is seeded with items and events the command then reads)
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Seed submitted items with a brief naming files, and file_miss events for some, on the project's real board file. */
function seed(box, rows) {
  // @pullboard-board-file journey: the real CLI then reads these rows from the board file it wrote
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), (board) => {
    for (const { files, miss } of rows) {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Predicts ${files}`, brief: `Files: ${files}` });
      store.logEvent(board, 'web-1', 'submit', id, { commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
      if (miss) store.logEvent(board, 'web-1', 'file_miss', id, miss);
    }
  });
}

test('cli.io-commands-capacity-prediction.pullboard-capacity-prints-prediction-accuracy-from-recorded: clause 1: pullboard capacity prints prediction accuracy from recorded misses [C7,#8523]', async () => {
  const box = e2e.project();
  seed(box, [
    { files: 'web/a.html' },
    { files: 'web/b.html' },
    { files: 'web/c.html', miss: { predicted: ['web/c.html'], changed: ['web/d.html'], missed: ['web/c.html'], unpredicted: ['web/d.html'] } },
  ]);
  const text = await box.runLocal(box.repo, 'capacity');
  assert.equal(text.code, 0, text.err + text.out);
  assert.match(text.out, /file prediction: 2 of 3 submits matched their predicted files \(67%\); 1 predicted files untouched, 1 changed files unpredicted/u);
  const json = JSON.parse((await box.runLocal(box.repo, 'capacity', '--json')).out);
  assert.deepEqual(json.report.predictions, { predicted: 3, missed: 1, hit: 2, accuracy: 2 / 3, filesMissed: 1, filesUnpredicted: 1 });
});

test('cli.io-commands-capacity-prediction.with-no-recorded-submit-the-line-says: clause 1: with no recorded submit the line says the accuracy is unknown instead of printing zero [C7,#8523]', async () => {
  const box = e2e.project();
  const text = await box.runLocal(box.repo, 'capacity');
  assert.equal(text.code, 0, text.err + text.out);
  assert.match(text.out, /file prediction: unknown, no submit with predicted files is recorded yet/u);
});
