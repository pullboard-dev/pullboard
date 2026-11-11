/** next serves only the seat bound to the worktree it runs in, in that seat's lane, whatever session its seats share (GH #27). */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The one agent session every seat below shares, as subagents of one Claude Code session do. */
const SESSION = 'shared-session-27';

/** Run `work` with the shared session id set on the CLI, as a local agent shell has it. */
function shared(box, work) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = SESSION;
  try { return work(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/** Make a seat checkout in `lane` and join it under the shared session. */
function seat(box, lane, { lock = false } = {}) {
  const root = join(box.dir, `${lane}-seat`);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `${lane}/seat`);
  const joined = shared(box, () => joinFixtureSeat(box, root, lane, { model: FIXTURE_MODEL, lockLane: lock }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The seat ids on the board. */
function seatIds(box) {
  return JSON.parse(box.run(box.repo, 'agents', '--json').out).agents.map(agent => agent.agent_id ?? agent.id).sort();
}

test('clause 2: next in a seat made with --lock-lane never claims in the web lane or opens a seat, and only names the work [GH27]', () => {
  const box = e2e.project();
  const web = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web only work', check: 'true', args: ['--specs', 'G1'] });
  const api = seat(box, 'api', { lock: true });
  const other = seat(box, 'web');
  const before = seatIds(box);
  const next = shared(box, () => box.run(api.root, 'next'));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.doesNotMatch(next.out, /claimed #/u, all);
  assert.doesNotMatch(all, /you hold #|work in web-/u, all);
  assert.match(box.run(box.repo, 'show', String(web.item_id)).out, new RegExp(`^#${web.item_id}\\s+open\\b`, 'mu'));
  assert.deepEqual(seatIds(box), before, 'next opened no new seat');
  assert.ok(other.id);
});

test('clause 3: two seats of one session each run next and release in their own lane without NOT_YOURS [GH27]', () => {
  const box = e2e.project();
  const webItem = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web work', check: 'true', args: ['--specs', 'G1'] });
  const apiItem = fileFixtureItem(box, box.repo, { lane: 'api', title: 'Api work', check: 'true', args: ['--specs', 'G1'] });
  const api = seat(box, 'api');
  const web = seat(box, 'web');
  const before = seatIds(box);
  for (const [who, item] of [[api, apiItem], [web, webItem]]) {
    const id = String(item.item_id);
    const next = shared(box, () => box.run(who.root, 'next'));
    assert.equal(next.code, 0, `${next.out}\n${next.err}`);
    assert.match(next.out, new RegExp(`claimed #${id}:`, 'u'), next.out);
    assert.match(box.run(box.repo, 'show', id).out, new RegExp(`^#${id}\\s+claimed ${who.id}\\b`, 'mu'));
    const released = shared(box, () => box.run(who.root, 'release', id, '--reason', 'OTHER', '--note', 'fixture'));
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    assert.doesNotMatch(`${released.out}${released.err}`, /NOT_YOURS/u);
  }
  assert.deepEqual(seatIds(box), before, 'no seat was opened by either next');
});

test('clause 1: next in an idle api seat moves that same seat to the web lane, claims there, and releases without NOT_YOURS [GH27]', () => {
  const box = e2e.project();
  const web = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web only work', check: 'true', args: ['--specs', 'G1'] });
  const api = seat(box, 'api');
  const other = seat(box, 'web');
  const before = seatIds(box);
  const id = String(web.item_id);
  const next = shared(box, () => box.run(api.root, 'next'));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.match(next.out, /moved from api to web: api had nothing you can take/u, all);
  assert.match(next.out, new RegExp(`claimed #${id}:`, 'u'), all);
  assert.match(box.run(box.repo, 'show', id).out, new RegExp(`^#${id}\\s+claimed ${api.id}\\b`, 'mu'), 'the same seat holds it');
  assert.deepEqual(seatIds(box), before, 'no new seat was opened');
  const released = shared(box, () => box.run(api.root, 'release', id, '--reason', 'OTHER', '--note', 'fixture'));
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  assert.doesNotMatch(`${released.out}${released.err}`, /NOT_YOURS/u);
  assert.ok(other.id);
});
