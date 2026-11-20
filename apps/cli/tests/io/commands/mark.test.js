/** pullboard mark appends one mark event from the closed stage and reason lists and refuses anything else with no event [C7,#12157]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../fixtures/next/take.js';
import { runCliInProcess } from '../../fixtures/process.js';

const marks = (box, id) => box.board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id=? AND event_kind='mark' ORDER BY event_id").all(id);

/** Run mark from the builder's seat through the real command; nothing is stubbed. */
const mark = (box, ...args) => {
  const ran = runCliInProcess(['mark', ...args, '--json'], { cwd: box.seats.builder.path, env: box.env });
  return ran;
};

test('cli.mark.one-append: clause 1: pullboard mark ID smoke --start --ref SHA --at TIME appends exactly one mark event with stage, edge, ref and the given at [C7,#12157]', async t => {
  const box = await fixture(t);
  const id = box.add('Marked item');
  const at = new Date(box.clock.now().getTime() - 60_000).toISOString();
  const ran = await mark(box, String(id), 'smoke', '--start', '--ref', 'abc123', '--at', at);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const written = marks(box, id);
  assert.equal(written.length, 1, 'exactly one mark event');
  assert.equal(written[0].event_by, box.seats.builder.id);
  assert.deepEqual(JSON.parse(written[0].event_detail), { stage: 'smoke', edge: 'start', reason: null, ref: 'abc123', at: Date.parse(at) });
});

test('cli.mark.closed-lists: clause 2: an unknown stage, an unknown reason code and an --at more than 24 h from now are each refused with a code and no event [C7,#12157]', async t => {
  const box = await fixture(t);
  const id = String(box.add('Marked item'));
  const far = new Date(box.clock.now().getTime() + 25 * 3_600_000).toISOString();
  const cases = [[[id, 'bogus-stage', '--point'], 'MARK_STAGE'], [[id, 'smoke', '--point', '--reason', 'BOGUS'], 'MARK_REASON'], [[id, 'smoke', '--point', '--at', far], 'MARK_AT']];
  for (const [args, code] of cases) {
    const ran = await mark(box, ...args);
    assert.notEqual(ran.status, 0, code);
    assert.match(ran.stdout + ran.stderr, new RegExp(code, 'u'));
  }
  assert.equal(marks(box, id).length, 0, 'a refused mark writes no event');
});
