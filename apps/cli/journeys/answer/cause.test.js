/** pullboard answer takes --cause <key>: a ruling cause from the typed list is recorded on the answer, and any other key is refused with the valid keys [C7,#1444,#10979]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { workHelp } from '../../src/logic/help/work.js';
import { TYPED_REQUEST_CAUSES } from '../../../../packages/store/index.js';
import { withBoard } from '../../tests/fixtures/scenarios/team.js';

/** The answer events on the fixture board, each event's detail parsed, oldest first. */
function answers(root) {
  return withBoard(root, board => board.db.prepare('SELECT event_detail FROM event WHERE event_kind = ? ORDER BY event_id').all('answer').map(row => JSON.parse(row.event_detail)));
}

/** Ask one decision of the person on a fixture project and return the project box and the decision id. */
async function decision(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project();
  const asked = await box.runLocal(box.repo, 'shout', 'person', 'Which interface should this expose?', '--decision', '--json');
  assert.equal(asked.code, 0, `${asked.err}\n${asked.out}`);
  return { box, ask: JSON.parse(asked.out).id };
}

test('cli.journeys-answer-cause.a-listed-cause-is-recorded-on-the-answer: clause 1: pullboard answer with --cause design-choice exits 0 and the answer carries cause design-choice, read back from the board [C7,#1444,#10979]', async t => {
  const { box, ask } = await decision(t);
  const result = await box.runLocal(box.repo, 'answer', String(ask), 'Share it', '--as', 'person', '--cause', 'design-choice');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const written = answers(box.repo).filter(detail => detail.answers === ask);
  assert.equal(written.length, 1, 'one answer was written');
  assert.equal(written[0].cause, 'design-choice');
});

test('cli.journeys-answer-cause.a-cause-outside-the-list-is-refused: clause 2: pullboard answer with --cause not-a-key exits non-zero with RULING_CAUSE naming the valid keys, and writes no answer [C7,#1444,#10979]', async t => {
  const { box, ask } = await decision(t);
  const result = await box.runLocal(box.repo, 'answer', String(ask), 'Share it', '--as', 'person', '--cause', 'not-a-key');
  assert.notEqual(result.code, 0, 'an unknown cause is refused');
  assert.match(result.err + result.out, /RULING_CAUSE/u);
  for (const key of TYPED_REQUEST_CAUSES) assert.ok((result.err + result.out).includes(key), `the refusal names ${key}`);
  assert.equal(answers(box.repo).filter(detail => detail.answers === ask).length, 0, 'no answer was written');
});

test('cli.journeys-answer-cause.the-answer-usage-lists-the-cause-flag: clause 3: the answer usage in the work help lists --cause <key> [C7,#1444,#10979]', () => {
  assert.match(workHelp, /pullboard answer [^\n]*\n(?:[^\n]*\n){1,8}?[^\n]*\[--cause <key>\]/u);
});
