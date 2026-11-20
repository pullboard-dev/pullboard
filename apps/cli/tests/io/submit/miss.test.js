/** Submit records a predicted-versus-actual file miss on the item when claims.fileLease is on [C7,#8522,#1413]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaseBoard } from '../../fixtures/claim/lease.js';

const missEvents = (board, id) => board.db.prepare("SELECT event_detail AS detail FROM event WHERE item_id=? AND event_kind='file_miss'").all(id).map(row => { const { model, ...detail } = JSON.parse(row.detail); return detail; });

test('cli.journeys-submit-miss.a-submit-whose-changed-files-differ: clause 1: a submit whose changed files differ from the predicted files records a miss naming both on the item [C7,#8522]', t => {
  const { board, add, claim, first, submit } = leaseBoard(t, { hubs: [] });
  const id = add('Predicts the page', ['web/page.html', 'web/style.css']);
  claim(id, first);
  submit(id, first, ['web/page.html', 'web/other.js']);
  assert.deepEqual(missEvents(board, id), [{ predicted: ['web/page.html', 'web/style.css'], changed: ['web/page.html', 'web/other.js'], missed: ['web/style.css'], unpredicted: ['web/other.js'] }]);
});

test('cli.journeys-submit-miss.a-submit-that-changed-exactly-the: clause 1: a submit that changed exactly the predicted files records no miss [C7,#8522]', t => {
  const { board, add, claim, first, submit } = leaseBoard(t, { hubs: [] });
  const id = add('Predicts the page', ['web/page.html']);
  claim(id, first);
  submit(id, first, ['web/page.html']);
  assert.deepEqual(missEvents(board, id), []);
});

test('cli.journeys-submit-miss.with-the-setting-off-a-differing: clause 1: with the setting off a differing submit records nothing [C7,#8522]', t => {
  const { board, add, claim, first, submit } = leaseBoard(t, null);
  const id = add('Predicts the page', ['web/page.html']);
  claim(id, first);
  submit(id, first, ['web/other.js']);
  assert.deepEqual(missEvents(board, id), []);
});
