/** An agent loop of only next, next --done and next --stuck builds, submits and moves on across two items [C7,#11702]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** The release events an item recorded, with their detail parsed. */
const releases = (box, id) => box.board.db.prepare("SELECT event_detail d FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.d));

/** The loop: next, commit, next --done, then next --stuck on the second item; every call's text is kept. */
async function runLoop(t) {
  const box = await fixture(t);
  const first = box.add('The first loop item');
  const second = box.add('The second loop item');
  const cwd = box.seats.actor.path;
  const calls = [];
  const run = async args => { const ran = await cli(box, cwd, args); assert.equal(ran.code, 0, ran.out + ran.err); calls.push(ran); return ran; };
  await run(['next']);
  assert.equal(store.getItem(box.board, first).item_owner, box.seats.actor.id, 'the first next claimed the first item');
  mkdirSync(join(cwd, 'web'), { recursive: true });
  writeFileSync(join(cwd, 'web/loop.js'), 'export const loop = 1;\n');
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', 'feat(web): the first loop item [G1]', '-m', `Pullboard-Item: #${first}`);
  await run(['next', '--done']);
  assert.equal(store.getItem(box.board, second).item_owner, box.seats.actor.id, 'next --done claimed the second item');
  await run(['next', '--stuck', 'waits on the schema']);
  return { box, first, second, calls };
}

test('cli.journeys-next-loop.two-items-one-voice: clause 1: a seat that only runs next, next --done and next --stuck ends with the first item submitted, the second open with a BLOCKED release carrying the reason, and one next command per instruction [C7,#11702]', async t => {
  const { box, first, second, calls } = await runLoop(t);
  const gateJobs = box.board.db.prepare("SELECT job_id FROM job WHERE job_item=? AND job_kind='gate'").all(first);
  assert.ok(gateJobs.length > 0, 'the first item was handed to a gate by next --done');
  const [release] = releases(box, second);
  // The same call hands the only other open item out again, so the second item is open as a release the board recorded, not as an unowned row.
  assert.equal(release.reasonCode, 'BLOCKED');
  assert.equal(release.reason, 'waits on the schema');
  for (const ran of calls) {
    const instruction = ran.document?.next;
    assert.equal(typeof instruction, 'string', `a next instruction in: ${ran.out.slice(0, 200)}${ran.err.slice(0, 200)}`);
    assert.equal(instruction.match(/pullboard [a-z]+/gu).length, 1, `the instruction names one command: ${instruction}`);
  }
});

test('cli.journeys-next-loop.never-told-to-release: clause 2: across that loop no instruction or shout the seat reads tells it to release an item it holds [C7,#11702]', async t => {
  const { calls } = await runLoop(t);
  for (const ran of calls) assert.doesNotMatch(`${ran.out}${ran.err}`, /pullboard release/u, 'no instruction names release');
});
