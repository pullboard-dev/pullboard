/** pullboard claim runs the real claim writer and live claim table: with laneMode off a seat claims another lane's item in that item's lane, with laneMode on it is refused [C7,#10923]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { fixture } from '../../fixtures/next/take.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** Claim a docs item from the web seat's worktree through the real command; nothing is stubbed. */
async function claimDocs(box) {
  const id = box.add('Docs lane item', { lane: 'docs' });
  const ran = await runCliInProcess(['claim', String(id), '--json'], { cwd: box.seats.actor.path, env: box.env });
  return { id, ran, out: ran.stdout + ran.stderr };
}

test('cli.io-commands-claim.lanes-off-claims-other-lane: clause 1: with laneMode off a seat registered in web claims an open docs item, exit 0, and the seat holds it [C7,#10923]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const { id, ran, out } = await claimDocs(box);
  assert.equal(ran.status, 0, out);
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
});

test('cli.io-commands-claim.lanes-on-refuses-wrong-lane: clause 2: the same claim on a laneMode on board is refused WRONG_LANE naming both lanes [C7,#10923]', async t => {
  const box = await fixture(t);
  const { id, ran, out } = await claimDocs(box);
  assert.notEqual(ran.status, 0, out);
  assert.match(out, /WRONG_LANE/u);
  assert.match(out, /docs/u);
  assert.match(out, /web/u);
  assert.equal(store.getItem(box.board, id).item_owner, null, 'nothing is claimed');
});

test('cli.io-commands-claim.claim-runs-through-claim-ordered: clause 3: the claim runs through claimOrdered from the claim command, so the real writer and live claim table decide and the test stubs neither [C7,#10923]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const { id, ran, out } = await claimDocs(box);
  assert.equal(ran.status, 0, out);
  const claimed = box.board.db.prepare("SELECT COUNT(*) n FROM event WHERE item_id=? AND event_kind='claim' AND event_by=?").get(id, box.seats.actor.id).n;
  assert.equal(claimed, 1, 'the writer recorded the claim event');
});

test('cli.io-commands-claim.profile-names-phases: clause 1: with PULLBOARD_CLAIM_PROFILE set, pullboard claim prints one stderr line per claim phase as claim profile: <phase> <ms> ms plus a total line naming the slowest three, with it unset there is no claim profile line and --json stdout is unchanged, and every phase printed is one of the steps of run() in claim.js [C7,#12396]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } }), plainBox = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const first = box.add('Docs lane item', { lane: 'docs' }), second = plainBox.add('Docs lane item, claimed without the profile', { lane: 'docs' });
  const profiled = await runCliInProcess(['claim', String(first), '--json'], { cwd: box.seats.actor.path, env: { ...box.env, PULLBOARD_CLAIM_PROFILE: '1' } });
  assert.equal(profiled.status, 0, profiled.stdout + profiled.stderr);
  const lines = profiled.stderr.split('\n').filter(line => line.startsWith('claim profile: '));
  const total = lines.at(-1), phases = lines.slice(0, -1).map(line => /^claim profile: (\w+) \d+ ms$/u.exec(line)?.[1]);
  assert.ok(phases.length > 0 && phases.every(Boolean), `one phase line per step: ${lines.join(' | ')}`);
  assert.match(total, /^claim profile: total \d+ ms; slowest three: \w+(, \w+){0,2}$/u);
  assert.doesNotMatch(profiled.stdout, /claim profile/u, 'the profile goes to stderr, never stdout');
  /** The steps of run() in claim.js, in the order the profile source names them. */
  const named = ['sayQueuedReds', 'sayLag', 'cleanItemFolders', 'refuseClaimMissingPaths', 'claimFolderRefusal', 'claimOrdered', 'itemFileCollisions', 'openItemFolder'];
  for (const name of phases) assert.ok(named.includes(name), `${name} printed is a step of run()`);
  for (const name of ['sayQueuedReds', 'sayLag', 'cleanItemFolders', 'claimOrdered', 'itemFileCollisions', 'openItemFolder']) assert.ok(phases.includes(name), `${name} is timed`);
  const plain = await runCliInProcess(['claim', String(second), '--json'], { cwd: plainBox.seats.actor.path, env: plainBox.env });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.doesNotMatch(plain.stderr, /claim profile/u, 'unset, the claim prints no profile line');
  assert.doesNotThrow(() => JSON.parse(plain.stdout), '--json stdout stays one JSON document');
});
