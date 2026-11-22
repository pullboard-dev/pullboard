/** next serves only the seat bound to the worktree it runs in, in that seat's lane, whatever session its seats share (GH #27). */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The one agent session every seat below shares, as subagents of one Claude Code session do. */
const SESSION = 'shared-session-27';

/** Run `work` with the shared session id set on the CLI, as a local agent shell has it. */
async function shared(box, work) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = SESSION;
  try { return await work(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/** Make a seat checkout in `lane` and join it under the shared session. */
async function seat(box, lane, { lock = false } = {}) {
  const root = join(box.dir, `${lane}-seat`);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `${lane}/seat`);
  const joined = await shared(box, async () => joinFixtureSeat(box, root, lane, { model: FIXTURE_MODEL, lockLane: lock }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The seat ids on the board. */
async function seatIds(box) {
  return JSON.parse((await box.runLocal(box.repo, 'agents', '--json')).out).agents.map(agent => agent.agent_id ?? agent.id).sort();
}

test('cli.journeys-next-session.next-in-a-seat-made-with: clause 2: next in a seat made with --lock-lane never claims in the web lane or opens a seat, and only names the work [GH27]', async () => {
  const box = e2e.project();
  const web = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web only work', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api', { lock: true });
  const other = await seat(box, 'web');
  const before = await seatIds(box);
  const next = await shared(box, async () => (await box.runLocal(api.root, 'next')));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.doesNotMatch(next.out, /claimed #/u, all);
  assert.doesNotMatch(all, /you hold #|work in web-/u, all);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(web.item_id), '--json')).out).item_status, 'open');
  assert.deepEqual(await seatIds(box), before, 'next opened no new seat');
  assert.ok(other.id);
});

test('cli.journeys-next-session.two-seats-of-one-session-each: clause 3: two seats of one session each run next and release in their own lane without NOT_YOURS [GH27]', async () => {
  const box = e2e.project();
  const webItem = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web work', check: 'true', args: ['--specs', 'G1'] });
  const apiItem = fileFixtureItem(box, box.repo, { lane: 'api', title: 'Api work', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api');
  const web = await seat(box, 'web');
  const before = await seatIds(box);
  for (const [who, item] of [[api, apiItem], [web, webItem]]) {
    const id = String(item.item_id);
    const next = await shared(box, async () => (await box.runLocal(who.root, 'next')));
    assert.equal(next.code, 0, `${next.out}\n${next.err}`);
    assert.match(next.out, new RegExp(`claimed #${id}:`, 'u'), next.out);
    const shown = JSON.parse((await box.runLocal(box.repo, 'show', id, '--json')).out);
    assert.equal(shown.item_status, 'claimed');
    assert.equal(shown.item_owner, who.id);
    const released = await shared(box, async () => (await box.runLocal(who.root, 'release', id, '--reason', 'OTHER', '--note', 'fixture')));
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    assert.doesNotMatch(`${released.out}${released.err}`, /NOT_YOURS/u);
  }
  assert.deepEqual(await seatIds(box), before, 'no seat was opened by either next');
});

test('cli.journeys-next-session.next-in-an-idle-api-seat: clause 1: next in an idle api seat moves that same seat to the web lane, claims there, and releases without NOT_YOURS [GH27]', async () => {
  const box = e2e.project();
  const web = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web only work', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api');
  const other = await seat(box, 'web');
  const before = await seatIds(box);
  const id = String(web.item_id);
  const next = await shared(box, async () => (await box.runLocal(api.root, 'next')));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.match(next.out, /moved from api to web: api had nothing you can take/u, all);
  assert.match(next.out, new RegExp(`claimed #${id}:`, 'u'), all);
  const shownApi = JSON.parse((await box.runLocal(box.repo, 'show', id, '--json')).out);
  assert.equal(shownApi.item_status, 'claimed');
  assert.equal(shownApi.item_owner, api.id, 'the same seat holds it');
  assert.deepEqual(await seatIds(box), before, 'no new seat was opened');
  const released = await shared(box, async () => (await box.runLocal(api.root, 'release', id, '--reason', 'OTHER', '--note', 'fixture')));
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  assert.doesNotMatch(`${released.out}${released.err}`, /NOT_YOURS/u);
  assert.ok(other.id);
});


test('cli.release-committed-cleanup.retains-locked-custody: clauses 1-2: a committed release reports a real non-forced removal failure, preserves custody, and recovers through ordinary claim and release [C7,#12955]', async () => {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'api', title: 'Cleanup custody', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api');
  const id = String(item.item_id);
  const call = (...args) => shared(box, () => box.runLocal(api.root, ...args));
  const taken = await call('claim', id, '--no-next');
  assert.equal(taken.code, 0, taken.out + taken.err);
  const folder = `${api.root}-item-${id}`;
  const ref = `refs/heads/api/item-${id}`;
  const head = box.git(box.repo, 'rev-parse', ref);
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  const releases = () => db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='release'").get(item.item_id).n;
  const state = () => db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(item.item_id);
  box.git(box.repo, 'worktree', 'lock', '--reason', 'fixture custody retained', folder);
  try {
    const refused = await call('release', id, '--reason', 'INVALID', '--no-next');
    assert.notEqual(refused.code, 0, 'a genuine pre-release refusal stays nonzero');
    assert.match(refused.out + refused.err, /RELEASE_REASON/u);
    assert.equal(state().item_status, 'claimed');
    assert.equal(state().item_owner, api.id);
    assert.equal(releases(), 0, 'refusal committed no release');
    let released, thrown;
    try { released = await call('release', id, '--reason', 'OTHER', '--note', 'fixture', '--no-next', '--json'); }
    catch (error) { thrown = error; }
    assert.equal(state().item_status, 'open', 'release committed before cleanup');
    assert.equal(state().item_owner, null, 'the releasing seat has no durable claim');
    assert.equal(releases(), 1, 'exactly one release transition committed');
    assert.ok(existsSync(folder), 'failed removal leaves the real folder');
    assert.match(box.git(box.repo, 'worktree', 'list', '--porcelain'), /locked fixture custody retained/u, 'registration survives');
    assert.equal(box.git(box.repo, 'rev-parse', ref), head, 'failed removal never deletes the branch');
    assert.equal(thrown, undefined, 'postcommit failure returns an explicit outcome instead of an ambiguous exception');
    assert.equal(released.code, 1, 'unrecovered cleanup failure stays nonzero');
    const outcome = JSON.parse(released.out);
    assert.equal(outcome.released, true);
    assert.deepEqual(outcome.item, { id: item.item_id, status: 'open', owner: null });
    assert.equal(outcome.cleanup.status, 'failed');
    assert.match(outcome.cleanup.error, /locked/u, 'actual Git failure is visible');
    assert.match(outcome.cleanup.next, /show.*do not repeat release.*next/u, 'remedy distinguishes inspection and ordinary work from release retry');
    assert.match(released.err, /RELEASE_CLEANUP_FAILED/u, 'human output also names the incomplete cleanup');
  } finally {
    box.git(box.repo, 'worktree', 'unlock', folder);
    db.close();
  }
  const reclaimed = await call('claim', id, '--no-next');
  assert.equal(reclaimed.code, 0, reclaimed.out + reclaimed.err);
  const recovered = await call('release', id, '--reason', 'OTHER', '--note', 'fixture recovered', '--no-next');
  assert.equal(recovered.code, 0, recovered.out + recovered.err);
  assert.ok(!existsSync(folder), 'ordinary successful release cleans the unlocked owned folder');
  assert.equal(box.git(box.repo, 'rev-parse', ref), head, 'normal release retains the reusable branch');
});
